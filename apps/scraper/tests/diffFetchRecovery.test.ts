import { describe, it, expect } from "vitest";
import { processPageHtmls } from "../src/scraping/x/postFilter.ts";
import { decideLoopIteration, type FetchStopReason } from "../src/scraping/x/fetchTweets.ts";
import type { RawPost } from "../src/scraping/x/parseTweetDom.ts";

const TARGET = "zabi_poc";
const PAGE_SIZE = 20; // 1スクロールで新たに読み込まれる想定件数

function makeArticleHtml(id: string, datetime: string): string {
  return `
<article data-testid="tweet" role="article">
  <div data-testid="User-Name">
    <a href="/${TARGET}" role="link"><span>${TARGET}</span></a>
    <a href="/${TARGET}/status/${id}">
      <time datetime="${datetime}">${datetime}</time>
    </a>
  </div>
  <div data-testid="tweetText" lang="ja" dir="auto"><span>投稿 ${id}</span></div>
</article>`;
}

/**
 * fetchTweets.ts のスクロールループと同じ制御フロー（processPageHtmls → decideLoopIteration →
 * 停止判定）を、Playwright/DOM無しで駆動する。timeline は「DOM上に現れる順（新しい→古い）」の
 * 全記事HTMLで、1回のイテレーションごとに新たに PAGE_SIZE 件が可視化される（＝スクロールで
 * 少しずつ下の記事が読み込まれ、$$eval は毎回「現在まで見えている全記事」を返す、という
 * fetchTweets.ts の実挙動を模している）。
 */
function runSyntheticFetch(
  timeline: string[],
  options: {
    knownExternalPostIds: ReadonlySet<string>;
    requireFullKnownMatch: boolean;
    maxNewPostsPerRun: number;
    maxScrolls: number;
    initialTargetCount?: number;
  }
): { collected: Map<string, RawPost>; hitSafetyCap: boolean; stopReason: FetchStopReason; scrollsPerformed: number; totalKnown: number } {
  const isDiffMode = options.knownExternalPostIds.size > 0;
  const totalKnownIds = options.knownExternalPostIds.size;
  const collected = new Map<string, RawPost>();
  const seenArticleIds = new Set<string>();
  let consecutiveKnownStreak = 0;
  let noGrowth = 0;
  let totalKnown = 0;
  let totalValidSeen = 0;
  let hitSafetyCap = false;
  let boundaryExtraScrollsRemaining: number | null = null;
  let stopReason: FetchStopReason = "max_scrolls_reached";
  let scrollsPerformed = 0;

  for (let i = 0; i < options.maxScrolls; i++) {
    scrollsPerformed = i + 1;
    const visibleUpTo = Math.min(timeline.length, i * PAGE_SIZE + PAGE_SIZE);
    const htmls = timeline.slice(0, visibleUpTo); // $$evalは毎回「現在見えている全記事」を返す

    const totalValidSeenBefore = totalValidSeen;
    const result = processPageHtmls(htmls, TARGET, collected, {
      knownExternalPostIds: options.knownExternalPostIds,
      seenArticleIds,
      consecutiveKnownStreak,
    });
    consecutiveKnownStreak = result.consecutiveKnownStreak;
    totalKnown += result.known;
    totalValidSeen += result.added + result.known;

    const decision = decideLoopIteration({
      isDiffMode,
      collectedSize: collected.size,
      consecutiveKnownStreak,
      boundaryExtraScrollsRemaining,
      totalValidSeenBefore,
      totalValidSeenAfter: totalValidSeen,
      noGrowth,
      maxNewPostsPerRun: options.maxNewPostsPerRun,
      initialTargetCount: options.initialTargetCount ?? 14,
      requireFullKnownMatch: options.requireFullKnownMatch,
      matchedKnownCount: totalKnown,
      totalKnownIds,
    });
    boundaryExtraScrollsRemaining = decision.boundaryExtraScrollsRemaining;
    noGrowth = decision.noGrowth;
    if (decision.hitSafetyCap) hitSafetyCap = true;

    if (decision.stop) {
      stopReason = decision.stopReason ?? stopReason;
      break;
    }
    // タイムライン全件を見終えても、実際のfetchTweetsと同じくスクロールは継続する
    // （境界検出の安全マージン・stall検知は、これ以上新規が増えない状態が続くこと自体を
    // 判定条件として使うため、ここでショートカットしてはいけない）
  }

  return { collected, hitSafetyCap, stopReason, scrollsPerformed, totalKnown };
}

describe("差分取得: 安全上限超過からの複数回実行での完全回収", () => {
  // externalPostId は実際のX投稿IDと同じ「数値文字列のみ」制約がある（parseTweetArticle参照）。
  // タイムライン（新しい→古い）: 新規250件(newPostIds[0]が最新) → 既知(古い)10件
  const newPostIds = Array.from({ length: 250 }, (_, i) => String(9000000 + i)); // [0]=最新
  const oldKnownIds = Array.from({ length: 10 }, (_, i) => String(8000000 + i));
  const timeline = [
    ...newPostIds.map((id, i) => makeArticleHtml(id, `2026-08-10T${String(23 - (i % 24)).padStart(2, "0")}:00:00.000Z`)),
    ...oldKnownIds.map((id, i) => makeArticleHtml(id, `2026-08-0${9 - (i % 9)}T00:00:00.000Z`)),
  ];

  it("1回目: 安全上限(200)に到達して打ち切られ、hitSafetyCapがtrueになる", () => {
    const knownExternalPostIds = new Set(oldKnownIds);
    const run1 = runSyntheticFetch(timeline, {
      knownExternalPostIds,
      requireFullKnownMatch: false, // 前回打ち切りなし（通常モード）
      maxNewPostsPerRun: 200,
      maxScrolls: 40,
    });

    expect(run1.collected.size).toBe(200);
    expect(run1.hitSafetyCap).toBe(true);
    expect(run1.stopReason).toBe("max_new_posts_per_run_reached");
    // 最新200件（newPostIds[0..199]）が回収されている
    for (let i = 0; i < 200; i++) {
      expect(run1.collected.has(newPostIds[i])).toBe(true);
    }
    // 残り50件（newPostIds[200..249]）はまだ未回収
    for (let i = 200; i < 250; i++) {
      expect(run1.collected.has(newPostIds[i])).toBe(false);
    }
  });

  it("2回目（リカバリーモード、known-streakで早期停止しない）: 残り50件を全件回収し、hitSafetyCapはfalseに戻る", () => {
    const knownExternalPostIds = new Set(oldKnownIds);
    const run1 = runSyntheticFetch(timeline, {
      knownExternalPostIds,
      requireFullKnownMatch: false,
      maxNewPostsPerRun: 200,
      maxScrolls: 40,
    });

    // Worker側の実挙動を模す: run1で回収した投稿がDBに既知として追加され、
    // hitSafetyCap=trueが記録される → 2回目は「全既知投稿」と「リカバリーモード」で実行される
    const knownIdsForRun2 = new Set<string>([...oldKnownIds, ...run1.collected.keys()]);

    const run2 = runSyntheticFetch(timeline, {
      knownExternalPostIds: knownIdsForRun2,
      requireFullKnownMatch: true, // リカバリーモード
      maxNewPostsPerRun: 200,
      maxScrolls: 40,
    });

    // シナリオ: 2回目は残り50件だけが新規なので安全上限(200)には到達しない → 自己修復
    expect(run2.hitSafetyCap).toBe(false);
    expect(run2.stopReason).toBe("known_streak_boundary_with_margin");

    for (let i = 200; i < 250; i++) {
      expect(run2.collected.has(newPostIds[i])).toBe(true);
    }

    // --- 欠落0・重複0の検証 ---
    const allCollectedIds = new Set<string>([...run1.collected.keys(), ...run2.collected.keys()]);
    for (const id of newPostIds) {
      expect(allCollectedIds.has(id)).toBe(true); // 欠落0
    }
    expect(allCollectedIds.size).toBe(newPostIds.length); // 重複0（250件ちょうど）
    // run1とrun2の集合が重複していないことも確認（同じ投稿を二重に「新規」として集めていない）
    const intersection = [...run1.collected.keys()].filter((id) => run2.collected.has(id));
    expect(intersection).toEqual([]);
  });

  it("もし2回目もリカバリーモードを使わなかった場合は早期停止し、取りこぼしが再現する（回帰防止の対照実験）", () => {
    const knownExternalPostIds = new Set(oldKnownIds);
    const run1 = runSyntheticFetch(timeline, {
      knownExternalPostIds,
      requireFullKnownMatch: false,
      maxNewPostsPerRun: 200,
      maxScrolls: 40,
    });
    const knownIdsForRun2 = new Set<string>([...oldKnownIds, ...run1.collected.keys()]);

    const run2WithoutRecovery = runSyntheticFetch(timeline, {
      knownExternalPostIds: knownIdsForRun2,
      requireFullKnownMatch: false, // リカバリーモードを使わない（＝修正前の挙動）
      maxNewPostsPerRun: 200,
      maxScrolls: 40,
    });

    // 修正前の挙動だとknown streakで早期停止し、n201〜n250へ到達できない
    expect(run2WithoutRecovery.collected.size).toBe(0);
    expect(run2WithoutRecovery.stopReason).toBe("known_streak_boundary_with_margin");
  });
});
