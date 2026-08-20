import { describe, it, expect } from "vitest";
import { processPageHtmls, type RecoveryCursor } from "../src/scraping/x/postFilter.ts";
import { decideLoopIteration, type FetchStopReason } from "../src/scraping/x/fetchTweets.ts";
import { mergeRecoveryCursor } from "../src/jobs/fetchAndProcessTweets.ts";
import type { RawPost } from "../src/scraping/x/parseTweetDom.ts";

/**
 * recovery cursor方式の検証（2026-08）。
 *
 * 旧方式（knownExternalPostIds全件との一致を境界検出の条件にする）は、known IDセットが
 * 大きくなるほど（X側のプロフィールスクロールが実際にDOMへ出せる深さを超えると）
 * needsRecoveryが永久に収束しなくなる欠陥があり、staging実運用で実際に発生した
 * （既知セットが4月分まで膨張し、DOMは直近99件しか出せず、239件全件一致が要求されて
 * 収束不能になった）ため廃止した。
 *
 * 新方式は「前回どこまで遡ったか（recovery cursor）」を保存し、次回はそのcursor地点
 * （externalPostId一致 or publishedAtがcursor以前）に到達するまでのみ境界検出を抑制する。
 * known IDセットの総数には一切依存しない。
 */

const TARGET = "zabi_poc";
const PAGE_SIZE = 20; // 1スクロールで新たに読み込まれる想定件数

/** 基準時刻から`hoursAgo`時間前のISO8601文字列を返す（インデックス毎に厳密に単調減少させるため）。 */
const BASE_TIME = Date.parse("2026-08-20T00:00:00.000Z");
function hoursAgo(hoursAgo: number): string {
  return new Date(BASE_TIME - hoursAgo * 3600_000).toISOString();
}

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

interface SyntheticFetchResult {
  collected: Map<string, RawPost>;
  hitSafetyCap: boolean;
  stopReason: FetchStopReason;
  scrollsPerformed: number;
  totalKnown: number;
  cursorReached: boolean;
  oldestValidSeen: { externalPostId: string; publishedAt: string } | null;
  needsRecovery: boolean;
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
    recoveryCursor: RecoveryCursor | null;
    maxNewPostsPerRun: number;
    maxScrolls: number;
    initialTargetCount?: number;
  }
): SyntheticFetchResult {
  const isDiffMode = options.knownExternalPostIds.size > 0;
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
  let cursorReached = !options.recoveryCursor;
  let oldestValidSeen: { externalPostId: string; publishedAt: string } | null = null;

  for (let i = 0; i < options.maxScrolls; i++) {
    scrollsPerformed = i + 1;
    const visibleUpTo = Math.min(timeline.length, i * PAGE_SIZE + PAGE_SIZE);
    const htmls = timeline.slice(0, visibleUpTo); // $$evalは毎回「現在見えている全記事」を返す

    const totalValidSeenBefore = totalValidSeen;
    const result = processPageHtmls(htmls, TARGET, collected, {
      knownExternalPostIds: options.knownExternalPostIds,
      seenArticleIds,
      consecutiveKnownStreak,
      recoveryCursor: options.recoveryCursor,
      cursorReached,
    });
    consecutiveKnownStreak = result.consecutiveKnownStreak;
    totalKnown += result.known;
    totalValidSeen += result.added + result.known;
    cursorReached = result.cursorReached;
    if (result.oldestSeen && (!oldestValidSeen || Date.parse(result.oldestSeen.publishedAt) < Date.parse(oldestValidSeen.publishedAt))) {
      oldestValidSeen = result.oldestSeen;
    }

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
      cursorReached,
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

  const needsRecovery = isDiffMode && stopReason !== "known_streak_boundary_with_margin";
  return { collected, hitSafetyCap, stopReason, scrollsPerformed, totalKnown, cursorReached, oldestValidSeen, needsRecovery };
}

describe("シナリオ1: 差分取得 安全上限超過からの複数回実行での完全回収", () => {
  const newPostIds = Array.from({ length: 250 }, (_, i) => String(9000000 + i)); // [0]=最新
  const oldKnownIds = Array.from({ length: 10 }, (_, i) => String(8000000 + i));
  const timeline = [
    ...newPostIds.map((id, i) => makeArticleHtml(id, hoursAgo(i))), // i=0が最新、iが増えるほど厳密に古くなる
    ...oldKnownIds.map((id, i) => makeArticleHtml(id, hoursAgo(newPostIds.length + i))), // newPostIds全件より確実に古い
  ];

  it("1回目: 安全上限(200)に到達して打ち切られ、cursor候補（今回最古の到達点）が得られる", () => {
    const run1 = runSyntheticFetch(timeline, {
      knownExternalPostIds: new Set(oldKnownIds),
      recoveryCursor: null, // 初回はcursorなし
      maxNewPostsPerRun: 200,
      maxScrolls: 40,
    });

    expect(run1.collected.size).toBe(200);
    expect(run1.hitSafetyCap).toBe(true);
    expect(run1.stopReason).toBe("max_new_posts_per_run_reached");
    expect(run1.needsRecovery).toBe(true);
    for (let i = 0; i < 200; i++) expect(run1.collected.has(newPostIds[i])).toBe(true);
    for (let i = 200; i < 250; i++) expect(run1.collected.has(newPostIds[i])).toBe(false);

    // 今回到達した最古地点（=200件目、newPostIds[199]）がcursor候補になる
    expect(run1.oldestValidSeen?.externalPostId).toBe(newPostIds[199]);
  });

  it("2回目: 前回cursorに到達するまで境界検出を抑制し、残り50件を全件回収して自己修復する（欠落0・重複0）", () => {
    const run1 = runSyntheticFetch(timeline, {
      knownExternalPostIds: new Set(oldKnownIds),
      recoveryCursor: null,
      maxNewPostsPerRun: 200,
      maxScrolls: 40,
    });

    // Worker側の実挙動を模す: run1で回収した投稿がDBに既知として追加され、
    // 「今回最古の到達点」がrecovery cursorとして保存される（単調マージ、既存cursorはnull）
    const savedCursor = mergeRecoveryCursor(null, run1.oldestValidSeen);
    expect(savedCursor?.externalPostId).toBe(newPostIds[199]);

    const knownIdsForRun2 = new Set<string>([...oldKnownIds, ...run1.collected.keys()]);
    const run2 = runSyntheticFetch(timeline, {
      knownExternalPostIds: knownIdsForRun2,
      recoveryCursor: savedCursor,
      maxNewPostsPerRun: 200,
      maxScrolls: 40,
    });

    expect(run2.hitSafetyCap).toBe(false);
    expect(run2.stopReason).toBe("known_streak_boundary_with_margin");
    expect(run2.needsRecovery).toBe(false);
    expect(run2.cursorReached).toBe(true);

    for (let i = 200; i < 250; i++) expect(run2.collected.has(newPostIds[i])).toBe(true);

    // --- 欠落0・重複0の検証 ---
    const allCollectedIds = new Set<string>([...run1.collected.keys(), ...run2.collected.keys()]);
    for (const id of newPostIds) expect(allCollectedIds.has(id)).toBe(true); // 欠落0
    expect(allCollectedIds.size).toBe(newPostIds.length); // 重複0（250件ちょうど）
    const intersection = [...run1.collected.keys()].filter((id) => run2.collected.has(id));
    expect(intersection).toEqual([]); // run1/run2で二重に「新規」収集されていない
  });

  it("もしcursorを使わなかった場合は早期停止し、取りこぼしが再現する（回帰防止の対照実験）", () => {
    const run1 = runSyntheticFetch(timeline, {
      knownExternalPostIds: new Set(oldKnownIds),
      recoveryCursor: null,
      maxNewPostsPerRun: 200,
      maxScrolls: 40,
    });
    const knownIdsForRun2 = new Set<string>([...oldKnownIds, ...run1.collected.keys()]);

    const run2WithoutCursor = runSyntheticFetch(timeline, {
      knownExternalPostIds: knownIdsForRun2,
      recoveryCursor: null, // cursorを使わない（＝修正前相当）
      maxNewPostsPerRun: 200,
      maxScrolls: 40,
    });

    expect(run2WithoutCursor.collected.size).toBe(0);
    expect(run2WithoutCursor.stopReason).toBe("known_streak_boundary_with_margin");
  });
});

describe("シナリオ2: 既知投稿が1000件存在してもDOM上では直近100件程度しか見えない場合でも収束する", () => {
  // 「knownExternalPostIds全件一致」を要求する旧方式だとDOM上に一度も出てこない残り900件との
  // 一致を永久に待ち続けて収束しないが、新方式はcursorの有無だけで判定するため無関係に収束する。
  const visiblePostIds = Array.from({ length: 100 }, (_, i) => String(7000000 + i));
  const timeline = visiblePostIds.map((id, i) => makeArticleHtml(id, `2026-06-${String(30 - (i % 28)).padStart(2, "0")}T00:00:00.000Z`));
  // 既知セットは「DOMに出てくる100件」+「DOM上には一切現れない過去分900件」の合計1000件
  const invisibleOldIds = Array.from({ length: 900 }, (_, i) => String(6000000 + i));
  const knownExternalPostIds = new Set<string>([...visiblePostIds, ...invisibleOldIds]);

  it("cursorなし（通常の差分取得）でも1000件全件との一致を要求せず、既知境界で正常に収束する", () => {
    const run = runSyntheticFetch(timeline, {
      knownExternalPostIds,
      recoveryCursor: null,
      maxNewPostsPerRun: 200,
      maxScrolls: 40,
    });

    expect(run.collected.size).toBe(0); // 全件既知なので新規0
    expect(run.stopReason).toBe("known_streak_boundary_with_margin");
    expect(run.needsRecovery).toBe(false);
  });

  it("直前の実行がrecoveryだった場合（cursorがDOM可視範囲内）でも、900件の不可視分を待たずに収束する", () => {
    const cursor: RecoveryCursor = { externalPostId: visiblePostIds[50], publishedAt: null };
    const run = runSyntheticFetch(timeline, {
      knownExternalPostIds,
      recoveryCursor: cursor,
      maxNewPostsPerRun: 200,
      maxScrolls: 40,
    });

    expect(run.cursorReached).toBe(true);
    expect(run.stopReason).toBe("known_streak_boundary_with_margin");
    expect(run.needsRecovery).toBe(false);
  });
});

describe("シナリオ3: archived投稿が大量に存在してもrecovery完了可能（archiveはknownExternalPostIdsに区別なく含まれるため無関係）", () => {
  it("archived分を含む巨大なknownセットでも、cursor到達後は正常に境界検出できる", () => {
    const newPostIds = Array.from({ length: 5 }, (_, i) => String(5000000 + i));
    const knownTailIds = Array.from({ length: 10 }, (_, i) => String(4000000 + i));
    const timeline = [
      ...newPostIds.map((id, i) => makeArticleHtml(id, `2026-08-15T${String(23 - i).padStart(2, "0")}:00:00.000Z`)),
      ...knownTailIds.map((id, i) => makeArticleHtml(id, `2026-08-1${4 - (i % 4)}T00:00:00.000Z`)),
    ];
    // archived分を模した大量の「DOM上には出てこない既知ID」を混ぜる（archiveはWorker側の状態であり
    // fetchTweetsからは通常のknown IDと見分けがつかない＝この巨大セットが収束を妨げないことの確認）。
    const archivedLikeIds = Array.from({ length: 5000 }, (_, i) => String(1000000 + i));
    const knownExternalPostIds = new Set<string>([...knownTailIds, ...archivedLikeIds]);

    const run = runSyntheticFetch(timeline, {
      knownExternalPostIds,
      recoveryCursor: { externalPostId: knownTailIds[0], publishedAt: null },
      maxNewPostsPerRun: 200,
      maxScrolls: 40,
    });

    expect(run.collected.size).toBe(5);
    expect(run.stopReason).toBe("known_streak_boundary_with_margin");
    expect(run.needsRecovery).toBe(false);
  });
});

describe("シナリオ4: cursor投稿がX上で削除済みでもpublishedAtフォールバックで継続できる", () => {
  it("cursorのexternalPostIdがDOM上に存在しなくても、publishedAt以前へ到達すれば未取得を飛ばさず収束する", () => {
    const newPostIds = Array.from({ length: 250 }, (_, i) => String(9000000 + i));
    const oldKnownIds = Array.from({ length: 10 }, (_, i) => String(8000000 + i));
    const timeline = [
      ...newPostIds.map((id, i) => makeArticleHtml(id, hoursAgo(i))),
      ...oldKnownIds.map((id, i) => makeArticleHtml(id, hoursAgo(newPostIds.length + i))),
    ];

    const run1 = runSyntheticFetch(timeline, {
      knownExternalPostIds: new Set(oldKnownIds),
      recoveryCursor: null,
      maxNewPostsPerRun: 200,
      maxScrolls: 40,
    });
    const savedCursor = mergeRecoveryCursor(null, run1.oldestValidSeen);
    expect(savedCursor).not.toBeNull();

    // cursor本体の投稿（newPostIds[199]）がX側で削除された想定でtimelineから除去する
    const deletedCursorId = savedCursor!.externalPostId;
    const timelineWithDeletion = timeline.filter((html) => !html.includes(`/status/${deletedCursorId}"`));

    const knownIdsForRun2 = new Set<string>([...oldKnownIds, ...run1.collected.keys()]);
    const run2 = runSyntheticFetch(timelineWithDeletion, {
      knownExternalPostIds: knownIdsForRun2,
      recoveryCursor: savedCursor, // externalPostIdはもうDOMに存在しないが、publishedAtは有効
      maxNewPostsPerRun: 200,
      maxScrolls: 40,
    });

    expect(run2.cursorReached).toBe(true); // publishedAtフォールバックで到達
    expect(run2.stopReason).toBe("known_streak_boundary_with_margin");
    for (let i = 200; i < 250; i++) expect(run2.collected.has(newPostIds[i])).toBe(true); // 未取得を飛ばさない
  });
});

describe("シナリオ5: cursor到達前にstallした場合はneedsRecoveryがtrueのまま維持される", () => {
  it("DOM成長がcursor到達前に止まる（stall）と、cursor未到達のままneedsRecovery=trueで終わる", () => {
    // タイムラインが小さく、cursorに到達する前にページが尽きてstallする状況を作る
    const shortTimeline = Array.from({ length: 5 }, (_, i) => makeArticleHtml(String(3000000 + i), `2026-08-05T0${i}:00:00.000Z`));
    const run = runSyntheticFetch(shortTimeline, {
      knownExternalPostIds: new Set(["3000000", "3000001", "3000002", "3000003", "3000004"]),
      recoveryCursor: { externalPostId: "9999999999", publishedAt: "2026-01-01T00:00:00.000Z" }, // timeline中には存在しない・十分未来のpublishedAtでもない深いcursor
      maxNewPostsPerRun: 200,
      maxScrolls: 10,
    });

    expect(run.cursorReached).toBe(false);
    expect(run.stopReason).toBe("stall_no_dom_growth");
    expect(run.needsRecovery).toBe(true);
  });
});

describe("mergeRecoveryCursor（単調マージ）", () => {
  it("既存cursorがnullならcandidateをそのまま採用する", () => {
    const candidate = { externalPostId: "1", publishedAt: "2026-08-01T00:00:00.000Z" };
    expect(mergeRecoveryCursor(null, candidate)).toEqual(candidate);
  });

  it("candidateがnull（今回有効な投稿が1件も無かった）なら既存cursorを維持する", () => {
    const existing = { externalPostId: "1", publishedAt: "2026-08-01T00:00:00.000Z" };
    expect(mergeRecoveryCursor(existing, null)).toEqual(existing);
  });

  it("candidateの方が古ければ前進（採用）する", () => {
    const existing = { externalPostId: "1", publishedAt: "2026-08-05T00:00:00.000Z" };
    const candidate = { externalPostId: "2", publishedAt: "2026-08-01T00:00:00.000Z" }; // より古い
    expect(mergeRecoveryCursor(existing, candidate)).toEqual(candidate);
  });

  it("candidateの方が新しければ既存cursorを維持する（後退しない）", () => {
    const existing = { externalPostId: "1", publishedAt: "2026-08-01T00:00:00.000Z" };
    const candidate = { externalPostId: "2", publishedAt: "2026-08-05T00:00:00.000Z" }; // より新しい
    expect(mergeRecoveryCursor(existing, candidate)).toEqual(existing);
  });
});
