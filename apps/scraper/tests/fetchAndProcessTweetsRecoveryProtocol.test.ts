import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { processPageHtmls } from "../src/scraping/x/postFilter.ts";
import type { RawPost } from "../src/scraping/x/parseTweetDom.ts";

/**
 * test.md記載の要件: 「走査未完了（needsRecovery）」の保存は新規投稿をingestするより前に行い、
 * 保存に失敗したらingestしない（fail-hard）。逆に走査完了時の解除（false化）はingest成功後に
 * 行い、失敗しても安全側（recoveryモード継続）に倒れる、という非対称な二段階プロトコルを検証する。
 *
 * fetchTweets（Playwright依存）はモックし、`decideLoopIteration`・`processPageHtmls`という
 * 実装本体（テスト対象外の既存ロジック、diffFetchRecovery.test.tsで別途検証済み）を使って
 * 「走査結果」を模擬生成する。ここでのテスト対象は main() の呼び出し順序・fail-hard判定であり、
 * スクロール判定アルゴリズム自体の正しさではない。
 */

vi.mock("../src/scraping/x/fetchTweets.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scraping/x/fetchTweets.ts")>();
  return { ...actual, fetchTweets: vi.fn() };
});

const TARGET = "zabi_poc";
const PAGE_SIZE = 20;

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

/** 実装の decideLoopIteration/processPageHtmls を使い、Playwright無しで fetchTweets を模擬する。 */
async function simulateFetchTweets(
  timeline: string[],
  opts: {
    knownExternalPostIds?: ReadonlySet<string>;
    maxNewPostsPerRun?: number;
    maxScrolls?: number;
    maxPosts?: number;
    recoveryCursorExternalPostId?: string | null;
    recoveryCursorPublishedAt?: string | null;
  }
) {
  const { decideLoopIteration } = await import("../src/scraping/x/fetchTweets.ts");
  const knownExternalPostIds = opts.knownExternalPostIds ?? new Set<string>();
  const isDiffMode = knownExternalPostIds.size > 0;
  const recoveryCursor =
    opts.recoveryCursorExternalPostId || opts.recoveryCursorPublishedAt
      ? { externalPostId: opts.recoveryCursorExternalPostId ?? null, publishedAt: opts.recoveryCursorPublishedAt ?? null }
      : null;
  const isRecovery = isDiffMode && recoveryCursor !== null;
  const maxNewPostsPerRun = opts.maxNewPostsPerRun ?? 200;
  const maxScrolls = opts.maxScrolls ?? 60;
  const initialTargetCount = opts.maxPosts ?? 14;

  const collected = new Map<string, RawPost>();
  const seenArticleIds = new Set<string>();
  let consecutiveKnownStreak = 0;
  let noGrowth = 0;
  let totalKnown = 0;
  let totalSkippedPinned = 0;
  let totalSkippedWrongAuthor = 0;
  let totalValidSeen = 0;
  let hitSafetyCap = false;
  let boundaryExtraScrollsRemaining: number | null = null;
  let stopReason: "initial_run_target_reached" | "max_new_posts_per_run_reached" | "known_streak_boundary_with_margin" | "stall_no_dom_growth" | "max_scrolls_reached" =
    "max_scrolls_reached";
  let scrollsPerformed = 0;
  let cursorReached = !recoveryCursor;
  let oldestValidSeen: { externalPostId: string; publishedAt: string } | null = null;

  for (let i = 0; i < maxScrolls; i++) {
    scrollsPerformed = i + 1;
    const visibleUpTo = Math.min(timeline.length, i * PAGE_SIZE + PAGE_SIZE);
    const htmls = timeline.slice(0, visibleUpTo);

    const totalValidSeenBefore = totalValidSeen;
    const result = processPageHtmls(htmls, TARGET, collected, {
      knownExternalPostIds,
      seenArticleIds,
      consecutiveKnownStreak,
      recoveryCursor,
      cursorReached,
    });
    consecutiveKnownStreak = result.consecutiveKnownStreak;
    totalKnown += result.known;
    totalSkippedPinned += result.skippedPinned;
    totalSkippedWrongAuthor += result.skippedWrongAuthor;
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
      maxNewPostsPerRun,
      initialTargetCount,
      cursorReached,
    });
    boundaryExtraScrollsRemaining = decision.boundaryExtraScrollsRemaining;
    noGrowth = decision.noGrowth;
    if (decision.hitSafetyCap) hitSafetyCap = true;

    if (decision.stop) {
      stopReason = decision.stopReason ?? stopReason;
      break;
    }
  }

  const sorted = [...collected.values()].sort((a, b) => {
    const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return tb - ta;
  });
  const posts = isDiffMode ? sorted : sorted.slice(0, initialTargetCount);
  const needsRecovery = isDiffMode && stopReason !== "known_streak_boundary_with_margin";

  return {
    posts,
    stats: {
      mode: isDiffMode ? ("diff" as const) : ("initial" as const),
      recoveryMode: isRecovery,
      cursorReached,
      scrollsPerformed,
      targetUserPostsSeen: totalValidSeen,
      knownPosts: totalKnown,
      newPosts: posts.length,
      skippedPinned: totalSkippedPinned,
      skippedWrongAuthor: totalSkippedWrongAuthor,
      hitSafetyCap,
      stopReason,
      needsRecovery,
      oldestValidSeenExternalPostId: oldestValidSeen?.externalPostId ?? null,
      oldestValidSeenPublishedAt: oldestValidSeen?.publishedAt ?? null,
    },
  };
}

/** known-external-ids / scrape-run-result / ingest を模擬するインメモリWorker。 */
function createFakeWorker() {
  const sourcePosts = new Map<string, { publishedAt: string }>();
  let needsRecovery = false;
  let recoveryCursorExternalPostId: string | null = null;
  let recoveryCursorPublishedAt: string | null = null;
  const ingestedIds: string[] = [];
  const calls: { url: string; method: string }[] = [];

  async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });

    if (url.includes("/internal/source-posts/known-external-ids") && method === "GET") {
      const limitParam = new URL(url).searchParams.get("limit");
      const limit = limitParam ? Number(limitParam) : 200;
      const ids = [...sourcePosts.entries()].sort((a, b) => (a[1].publishedAt < b[1].publishedAt ? 1 : -1)).map(([id]) => id);
      const externalPostIds = needsRecovery ? ids : ids.slice(0, limit);
      return new Response(
        JSON.stringify({ ok: true, externalPostIds, needsRecovery, recoveryCursorExternalPostId, recoveryCursorPublishedAt }),
        { status: 200 }
      );
    }

    if (url.includes("/internal/source-posts/scrape-run-result") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      needsRecovery = Boolean(body.needsRecovery);
      if ("recoveryCursorExternalPostId" in body) recoveryCursorExternalPostId = body.recoveryCursorExternalPostId;
      if ("recoveryCursorPublishedAt" in body) recoveryCursorPublishedAt = body.recoveryCursorPublishedAt;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (url.endsWith("/ingest") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const id = body.sourcePost.externalPostId;
      sourcePosts.set(id, { publishedAt: body.sourcePost.publishedAt });
      ingestedIds.push(id);
      return new Response(JSON.stringify({ ok: true, action: "inserted", sourcePostId: sourcePosts.size, externalPostId: id }), { status: 200 });
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  }

  return {
    handle,
    sourcePosts,
    ingestedIds,
    calls,
    getNeedsRecovery: () => needsRecovery,
    getRecoveryCursor: () => ({ recoveryCursorExternalPostId, recoveryCursorPublishedAt }),
    seedKnown(id: string, publishedAt: string) {
      sourcePosts.set(id, { publishedAt });
    },
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.INGEST_URL = "http://localhost:8787/ingest";
  process.env.INGEST_TOKEN = "test-token";
  process.env.TARGET_USER = TARGET;
  process.env.MAX_NEW_POSTS_PER_RUN = "200";
  process.env.MAX_SCROLLS = "40";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("needsRecovery 二段階保存プロトコル", () => {
  it("シナリオ2: 走査未完了 → needsRecovery=true 保存APIが失敗 → ingest 0件・実行失敗", async () => {
    const { fetchTweets } = await import("../src/scraping/x/fetchTweets.ts");
    vi.mocked(fetchTweets).mockResolvedValue({
      posts: [{ tweetId: "1", authorId: null, authorUsername: TARGET, authorDisplayName: null, bodyText: "x", publishedAt: null, sourceUrl: "", externalUrls: [], externalLinks: [], imageUrls: [], rawHtml: "", cleanedHtml: "" }],
      stats: {
        mode: "diff",
        recoveryMode: false,
        cursorReached: true,
        scrollsPerformed: 10,
        targetUserPostsSeen: 200,
        knownPosts: 0,
        newPosts: 1,
        skippedPinned: 0,
        skippedWrongAuthor: 0,
        hitSafetyCap: true,
        stopReason: "max_new_posts_per_run_reached",
        needsRecovery: true,
        oldestValidSeenExternalPostId: null,
        oldestValidSeenPublishedAt: null,
      },
    });

    const ingestMock = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("known-external-ids")) {
          return new Response(JSON.stringify({ ok: true, externalPostIds: ["999"], needsRecovery: false }), { status: 200 });
        }
        if (url.includes("scrape-run-result")) {
          return new Response(JSON.stringify({ ok: false, error: "internal_error" }), { status: 500 }); // 保存失敗
        }
        if (url.endsWith("/ingest")) {
          ingestMock(init);
          return new Response(JSON.stringify({ ok: true, action: "inserted" }), { status: 200 });
        }
        throw new Error(`unexpected: ${url}`);
      })
    );

    const { main } = await import("../src/jobs/fetchAndProcessTweets.ts");
    await expect(main()).rejects.toThrow(/needsRecovery.*保存に失敗|保存に失敗.*needsRecovery/);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("シナリオ3: 走査完了 → ingest成功後、needsRecovery=false解除APIが失敗しても実行自体は成功する", async () => {
    const { fetchTweets } = await import("../src/scraping/x/fetchTweets.ts");
    const post: RawPost = {
      tweetId: "111",
      authorId: null,
      authorUsername: TARGET,
      authorDisplayName: null,
      bodyText: "x",
      publishedAt: "2026-08-19T00:00:00.000Z",
      sourceUrl: "https://x.com/zabi_poc/status/111",
      externalUrls: [],
      externalLinks: [],
      imageUrls: [],
      rawHtml: "",
      cleanedHtml: "",
    };
    vi.mocked(fetchTweets).mockResolvedValue({
      posts: [post],
      stats: {
        mode: "diff",
        recoveryMode: true,
        cursorReached: true,
        scrollsPerformed: 5,
        targetUserPostsSeen: 210,
        knownPosts: 209,
        newPosts: 1,
        skippedPinned: 0,
        skippedWrongAuthor: 0,
        hitSafetyCap: false,
        stopReason: "known_streak_boundary_with_margin", // 走査完了
        needsRecovery: false,
        oldestValidSeenExternalPostId: null,
        oldestValidSeenPublishedAt: null,
      },
    });

    let scrapeRunResultCalls = 0;
    const ingestMock = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("known-external-ids")) {
          return new Response(JSON.stringify({ ok: true, externalPostIds: ["999"], needsRecovery: true }), { status: 200 });
        }
        if (url.includes("scrape-run-result")) {
          scrapeRunResultCalls++;
          return new Response(JSON.stringify({ ok: false }), { status: 500 }); // 解除失敗（false化に失敗）
        }
        if (url.endsWith("/ingest")) {
          ingestMock();
          return new Response(JSON.stringify({ ok: true, action: "inserted" }), { status: 200 });
        }
        throw new Error(`unexpected: ${url}`);
      })
    );

    const { main } = await import("../src/jobs/fetchAndProcessTweets.ts");
    await expect(main()).resolves.toBeUndefined(); // 解除失敗でも実行自体は失敗しない
    expect(ingestMock).toHaveBeenCalledTimes(1); // ingestは実行された
    expect(scrapeRunResultCalls).toBe(1); // 解除は試みられた（ingestの後）
  });

  it("シナリオ4: MAX_SCROLLS到達かつ既知境界未到達 → needsRecovery=true", async () => {
    const { fetchTweets } = await import("../src/scraping/x/fetchTweets.ts");
    vi.mocked(fetchTweets).mockResolvedValue({
      posts: [],
      stats: {
        mode: "diff",
        recoveryMode: false,
        cursorReached: true,
        scrollsPerformed: 40,
        targetUserPostsSeen: 5,
        knownPosts: 2,
        newPosts: 0,
        skippedPinned: 0,
        skippedWrongAuthor: 0,
        hitSafetyCap: false,
        stopReason: "max_scrolls_reached",
        needsRecovery: true,
        oldestValidSeenExternalPostId: null,
        oldestValidSeenPublishedAt: null,
      },
    });

    const order: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("known-external-ids")) {
          return new Response(JSON.stringify({ ok: true, externalPostIds: ["999"], needsRecovery: false }), { status: 200 });
        }
        if (url.includes("scrape-run-result")) {
          const body = JSON.parse(String(init?.body ?? "{}"));
          order.push(`save:${body.needsRecovery}`);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/ingest")) {
          order.push("ingest");
          return new Response(JSON.stringify({ ok: true, action: "inserted" }), { status: 200 });
        }
        throw new Error(`unexpected: ${url}`);
      })
    );

    const { main } = await import("../src/jobs/fetchAndProcessTweets.ts");
    await main();
    expect(order).toEqual(["save:true"]); // 新規0件なのでingestは呼ばれないが、保存は行われる
  });

  it("シナリオ5: stallかつ既知境界未到達 → needsRecovery=true、保存はingestより前に行われる", async () => {
    const { fetchTweets } = await import("../src/scraping/x/fetchTweets.ts");
    const post: RawPost = {
      tweetId: "222",
      authorId: null,
      authorUsername: TARGET,
      authorDisplayName: null,
      bodyText: "x",
      publishedAt: "2026-08-19T00:00:00.000Z",
      sourceUrl: "https://x.com/zabi_poc/status/222",
      externalUrls: [],
      externalLinks: [],
      imageUrls: [],
      rawHtml: "",
      cleanedHtml: "",
    };
    vi.mocked(fetchTweets).mockResolvedValue({
      posts: [post],
      stats: {
        mode: "diff",
        recoveryMode: false,
        cursorReached: true,
        scrollsPerformed: 8,
        targetUserPostsSeen: 3,
        knownPosts: 2,
        newPosts: 1,
        skippedPinned: 0,
        skippedWrongAuthor: 0,
        hitSafetyCap: false,
        stopReason: "stall_no_dom_growth",
        needsRecovery: true,
        oldestValidSeenExternalPostId: null,
        oldestValidSeenPublishedAt: null,
      },
    });

    const order: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("known-external-ids")) {
          return new Response(JSON.stringify({ ok: true, externalPostIds: ["999"], needsRecovery: false }), { status: 200 });
        }
        if (url.includes("scrape-run-result")) {
          const body = JSON.parse(String(init?.body ?? "{}"));
          order.push(`save:${body.needsRecovery}`);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/ingest")) {
          order.push("ingest");
          return new Response(JSON.stringify({ ok: true, action: "inserted" }), { status: 200 });
        }
        throw new Error(`unexpected: ${url}`);
      })
    );

    const { main } = await import("../src/jobs/fetchAndProcessTweets.ts");
    await main();
    expect(order).toEqual(["save:true", "ingest"]); // 保存 → ingest の順であること（逆はNG）
  });

  it("シナリオ1: 250件/cap=200 → 1回目はrecovery=true保存成功後200件ingest、2回目は残り50件を取得し全250件・欠落0・重複0", async () => {
    const newPostIds = Array.from({ length: 250 }, (_, i) => String(9000000 + i));
    const oldKnownIds = Array.from({ length: 10 }, (_, i) => String(8000000 + i));
    const timeline = [
      ...newPostIds.map((id, i) => makeArticleHtml(id, hoursAgo(i))),
      ...oldKnownIds.map((id, i) => makeArticleHtml(id, hoursAgo(newPostIds.length + i))),
    ];

    const { fetchTweets } = await import("../src/scraping/x/fetchTweets.ts");
    vi.mocked(fetchTweets).mockImplementation((opts) => simulateFetchTweets(timeline, opts as any) as any);

    const worker = createFakeWorker();
    for (const [i, id] of oldKnownIds.entries()) worker.seedKnown(id, hoursAgo(newPostIds.length + i));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => worker.handle(input, init)));

    const { main } = await import("../src/jobs/fetchAndProcessTweets.ts");

    // --- 1回目 ---
    await main();
    expect(worker.ingestedIds.length).toBe(200);
    expect(worker.getNeedsRecovery()).toBe(true);
    // 走査未完了なら、ingestより前にcursorが保存されているはず（今回の到達点=200件目）
    const cursorAfterRun1 = worker.getRecoveryCursor();
    expect(cursorAfterRun1.recoveryCursorExternalPostId).toBe(newPostIds[199]);

    // --- 2回目 ---
    await main();

    const allIngested = new Set(worker.ingestedIds);
    for (const id of newPostIds) {
      expect(allIngested.has(id)).toBe(true); // 欠落0
    }
    expect(allIngested.size).toBe(newPostIds.length); // 重複0（250件ちょうど。ingestedIdsは配列だが2回目は残り50件のみ新規送信されるはず）
    // 走査完了後はcursorが解除されている
    const cursorAfterRun2 = worker.getRecoveryCursor();
    expect(cursorAfterRun2.recoveryCursorExternalPostId).toBeNull();
    expect(worker.ingestedIds.length).toBe(250); // 1回目200件 + 2回目50件 = 250件（同一IDの再送信なし）
    expect(worker.getNeedsRecovery()).toBe(false); // 2回目で走査完了・自己修復
  });
});
