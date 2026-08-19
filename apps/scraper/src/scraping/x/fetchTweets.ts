import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { AUTH_STATE } from "../../paths.ts";
import { ARTICLE_SELECTOR } from "./selectors.ts";
import { type RawPost } from "./parseTweetDom.ts";
import { processPageHtmls } from "./postFilter.ts";

export interface FetchOptions {
  targetUser?: string;
  /** 初回モード（knownExternalPostIds が空）の目標件数。互換のため既定14。差分モードでは無視される。 */
  maxPosts?: number;
  headless?: boolean;
  /**
   * 差分取得用の既知 externalPostId 集合（DB照会結果）。空/未指定なら初回モード
   * （＝従来どおり最新 maxPosts 件を取得）。1件以上あれば差分モードになり、
   * 「前回取得済み地点までプロフィールを遡り、それ以降の本人投稿を全件取得する」。
   */
  knownExternalPostIds?: ReadonlySet<string>;
  /** 差分モードの安全上限（新規投稿件数）。既定200。暴走防止。到達時は警告ログを出す。 */
  maxNewPostsPerRun?: number;
  /** 最大スクロール回数。既定60。到達時は警告ログを出す。 */
  maxScrolls?: number;
  /**
   * リカバリーモード（前回の差分取得が安全上限で打ち切られていた場合に true）。
   * 通常モードは「連続既知投稿4件」で境界検出するが、前回打ち切りがあった場合はそれだけでは
   * 誤検出する（安全上限で打ち切った200件の直後が既知投稿の塊になり、その奥に未取得の投稿が
   * 埋もれている可能性があるため）。true の場合、knownExternalPostIds の全件と一致するまで
   * 境界検出を行わない（呼び出し元は knownExternalPostIds も全件取得したセットを渡すこと）。
   */
  recoveryMode?: boolean;
}

export type FetchStopReason =
  | "initial_run_target_reached"
  | "max_new_posts_per_run_reached"
  | "known_streak_boundary_with_margin"
  | "stall_no_dom_growth"
  | "max_scrolls_reached";

export interface FetchStats {
  mode: "initial" | "diff";
  /** リカバリーモード（既知投稿を全件と突合するまで境界検出しないモード）で実行されたか。 */
  recoveryMode: boolean;
  scrollsPerformed: number;
  /** 有効な本人投稿の総発見数（新規+既知）。 */
  targetUserPostsSeen: number;
  knownPosts: number;
  newPosts: number;
  skippedPinned: number;
  skippedWrongAuthor: number;
  hitSafetyCap: boolean;
  stopReason: FetchStopReason;
  /**
   * 走査未完了（＝「既知投稿の境界まで安全に到達し、安全マージンも完了した」と確認できないまま
   * 停止した）場合に true。差分モードで stopReason が "known_streak_boundary_with_margin"
   * 以外（安全上限到達／既知境界未確認のままMAX_SCROLLS到達／既知境界未確認のままstall）は
   * 全てこれに該当する。呼び出し元は、true の場合ingestより前にWorkerへ確実に保存し、
   * 保存に失敗したらingestを行わないこと（詳細は fetchAndProcessTweets.ts 参照）。
   * 初回モードではこの概念自体が適用されないため常に false。
   */
  needsRecovery: boolean;
}

export interface FetchResult {
  posts: RawPost[];
  stats: FetchStats;
}

/** 差分モードで「境界を検出した」とみなす連続既知投稿数。 */
const KNOWN_STREAK_STOP = 4;
/** 境界検出後、表示揺れ対策として追加でスクロールする回数（安全マージン）。 */
const EXTRA_SCROLLS_AFTER_BOUNDARY = 2;
/** 有効投稿の総発見数が何回連続で増えなければ「行き止まり」とみなすか。 */
const STALL_ITERATIONS = 3;

export interface LoopIterationInput {
  isDiffMode: boolean;
  /** 今回イテレーション終了時点の collected.size（新規投稿数）。 */
  collectedSize: number;
  /** 今回イテレーション終了時点の consecutiveKnownStreak（processPageHtmls の返り値）。 */
  consecutiveKnownStreak: number;
  /** 前回イテレーション終了時点の boundaryExtraScrollsRemaining（未検出なら null）。 */
  boundaryExtraScrollsRemaining: number | null;
  /** 今回イテレーション開始前の totalValidSeen（新規+既知の累計）。 */
  totalValidSeenBefore: number;
  /** 今回イテレーション終了後の totalValidSeen。 */
  totalValidSeenAfter: number;
  /** 直前までの stall 連続回数。 */
  noGrowth: number;
  maxNewPostsPerRun: number;
  initialTargetCount: number;
  /**
   * true の場合、knownExternalPostIds の全件（totalKnownIds）に到達するまで
   * 境界検出（known-streakによる早期停止）を行わない（前回打ち切りからのリカバリー用）。
   */
  requireFullKnownMatch: boolean;
  /** 今回イテレーション終了時点までの既知投稿の累計一致数。 */
  matchedKnownCount: number;
  /** 突合対象の既知 externalPostId の総数（knownExternalPostIds.size）。 */
  totalKnownIds: number;
}

export interface LoopIterationDecision {
  stop: boolean;
  stopReason: FetchStopReason | null;
  hitSafetyCap: boolean;
  boundaryExtraScrollsRemaining: number | null;
  noGrowth: number;
}

/**
 * 1スクロール分の処理結果を受け取り、「停止するか・なぜ停止するか」を判定する純粋関数。
 * Playwright に依存しないため fetchTweets のスクロールループから切り出してユニットテスト可能にする。
 */
export function decideLoopIteration(input: LoopIterationInput): LoopIterationDecision {
  const {
    isDiffMode,
    collectedSize,
    consecutiveKnownStreak,
    boundaryExtraScrollsRemaining: prevBoundaryExtraScrollsRemaining,
    totalValidSeenBefore,
    totalValidSeenAfter,
    noGrowth: prevNoGrowth,
    maxNewPostsPerRun,
    initialTargetCount,
    requireFullKnownMatch,
    matchedKnownCount,
    totalKnownIds,
  } = input;

  if (isDiffMode && collectedSize >= maxNewPostsPerRun) {
    return {
      stop: true,
      stopReason: "max_new_posts_per_run_reached",
      hitSafetyCap: true,
      boundaryExtraScrollsRemaining: prevBoundaryExtraScrollsRemaining,
      noGrowth: prevNoGrowth,
    };
  }

  if (!isDiffMode && collectedSize >= initialTargetCount) {
    return {
      stop: true,
      stopReason: "initial_run_target_reached",
      hitSafetyCap: false,
      boundaryExtraScrollsRemaining: prevBoundaryExtraScrollsRemaining,
      noGrowth: prevNoGrowth,
    };
  }

  let boundaryExtraScrollsRemaining = prevBoundaryExtraScrollsRemaining;
  if (isDiffMode) {
    // 安全マージンのカウントダウン中に新規投稿が見つかった（streakが0にリセットされた）場合、
    // まだ境界に到達していない証拠なのでカウントダウンを取り消す（表示揺れ・打ち切りリカバリー対策）。
    if (boundaryExtraScrollsRemaining !== null && consecutiveKnownStreak === 0) {
      boundaryExtraScrollsRemaining = null;
    }

    // リカバリーモードでは、既知投稿全件と一致するまで境界検出そのものを許可しない
    // （前回打ち切りで生じた「既知投稿の塊の奥に未取得投稿が埋もれている」ケースの取りこぼし防止）。
    const boundaryDetectionAllowed = !requireFullKnownMatch || matchedKnownCount >= totalKnownIds;

    if (boundaryExtraScrollsRemaining === null && boundaryDetectionAllowed && consecutiveKnownStreak >= KNOWN_STREAK_STOP) {
      boundaryExtraScrollsRemaining = EXTRA_SCROLLS_AFTER_BOUNDARY;
    } else if (boundaryExtraScrollsRemaining !== null) {
      boundaryExtraScrollsRemaining -= 1;
      if (boundaryExtraScrollsRemaining <= 0) {
        return {
          stop: true,
          stopReason: "known_streak_boundary_with_margin",
          hitSafetyCap: false,
          boundaryExtraScrollsRemaining,
          noGrowth: prevNoGrowth,
        };
      }
    }
  }

  if (totalValidSeenAfter === totalValidSeenBefore) {
    const noGrowth = prevNoGrowth + 1;
    if (noGrowth >= STALL_ITERATIONS) {
      return { stop: true, stopReason: "stall_no_dom_growth", hitSafetyCap: false, boundaryExtraScrollsRemaining, noGrowth };
    }
    return { stop: false, stopReason: null, hitSafetyCap: false, boundaryExtraScrollsRemaining, noGrowth };
  }

  return { stop: false, stopReason: null, hitSafetyCap: false, boundaryExtraScrollsRemaining, noGrowth: 0 };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, FS.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 投稿内の折り畳み/翻訳ボタンを全て押して本文を「日本語の全文」で展開する。
 * page.evaluate 内で直接 .click()（locator.click のアクション可能性チェック回避）。
 */
async function expandAllPosts(page: Page): Promise<void> {
  for (let round = 0; round < 12; round++) {
    const clicked = await page.evaluate((selector) => {
      let n = 0;
      for (const article of document.querySelectorAll(selector)) {
        for (const el of article.querySelectorAll('button, span[role="button"]')) {
          const t = (el as HTMLElement).innerText || "";
          if (/さらに表示|Show more|原文|Show original/.test(t)) {
            (el as HTMLElement).click();
            n++;
          }
        }
      }
      return n;
    }, ARTICLE_SELECTOR);
    if (clicked === 0) break;
    await page.waitForTimeout(600);
  }
}

/**
 * X プロフィールから投稿を生データで取得する（初回モード/差分モードの両対応）。
 *  - TARGET_USER 本人の投稿のみ採用（別ユーザー投稿・固定投稿は除外してログ出力）
 *  - 初回モード（knownExternalPostIds が空）: 従来どおり maxPosts 件集まるまでスクロールを継続する
 *  - 差分モード（knownExternalPostIds を指定）: 連続既知投稿（KNOWN_STREAK_STOP件）を検出し、
 *    安全マージン分さらにスクロールしてから停止する（＝前回取得地点まで遡って新規分を全件取得）
 *  - auth.json があればログイン状態（連続した最新投稿・翻訳解除が可能）
 *  - 画像/動画/フォントはDLブロック（URLは DOM から抽出するので不要）
 *  - 抽出は parseTweetArticle（linkedom）に一本化
 */
export async function fetchTweets(opts: FetchOptions = {}): Promise<FetchResult> {
  const targetUser = opts.targetUser ?? "Zabi_pokeka";
  const initialTargetCount = opts.maxPosts ?? 14;
  const knownExternalPostIds = opts.knownExternalPostIds;
  const isDiffMode = Boolean(knownExternalPostIds && knownExternalPostIds.size > 0);
  const requireFullKnownMatch = isDiffMode && Boolean(opts.recoveryMode);
  const totalKnownIds = knownExternalPostIds?.size ?? 0;
  const maxNewPostsPerRun = opts.maxNewPostsPerRun ?? 200;
  const maxScrolls = opts.maxScrolls ?? 60;
  const profileUrl = `https://x.com/${targetUser}`;

  const browser: Browser = await chromium.launch({ headless: opts.headless ?? true });
  const hasAuth = await fileExists(AUTH_STATE);
  console.log(hasAuth ? "[fetch] auth.json 検出（ログイン状態）" : "[fetch] auth.json なし（未ログイン）");
  console.log(
    isDiffMode
      ? `[fetch] 差分モード（既知投稿 ${totalKnownIds} 件と突合、リカバリーモード=${requireFullKnownMatch}）`
      : `[fetch] 初回モード（目標 ${initialTargetCount} 件）`
  );

  const context: BrowserContext = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    locale: "ja-JP",
    ...(hasAuth ? { storageState: AUTH_STATE } : {}),
  });

  // 画像は「本物のバイナリをDLせず」1x1 スタブで fulfill する。
  //   - abort だと X が画像URLをDOMへ書き込まない（背景画像はロード成功後にセットされるため）
  //   - スタブ fulfill ならロード成功扱いになり、media URL が DOM（背景/img）に入る＝抽出可能
  //   - 実画像バイナリは一切ダウンロードしない（要件: 画像バイナリDL禁止 を維持）
  // 動画・フォントは不要なので従来どおり abort。
  const STUB_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image") {
      return route.fulfill({ status: 200, contentType: "image/png", body: STUB_PNG });
    }
    if (type === "media" || type === "font") return route.abort();
    return route.continue();
  });

  const page = await context.newPage();
  try {
    console.log(`[fetch] アクセス中: ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    try {
      await page.waitForSelector(ARTICLE_SELECTOR, { timeout: 30000 });
    } catch {
      if (/\/login|\/i\/flow\/login/.test(page.url())) {
        throw new Error("ログインページへリダイレクトされました。auth.json を用意してください。");
      }
      throw new Error("投稿要素が見つかりません（構造変更 or レート制限の可能性）。");
    }

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
    let stopReason: FetchStopReason = "max_scrolls_reached";
    let scrollsPerformed = 0;

    for (let i = 0; i < maxScrolls; i++) {
      scrollsPerformed = i + 1;
      await expandAllPosts(page);

      const htmls: string[] = await page.$$eval(ARTICLE_SELECTOR, (els) =>
        els.map((e) => (e as HTMLElement).outerHTML)
      );

      const totalValidSeenBefore = totalValidSeen;
      const result = processPageHtmls(htmls, targetUser, collected, {
        knownExternalPostIds,
        seenArticleIds,
        consecutiveKnownStreak,
      });
      consecutiveKnownStreak = result.consecutiveKnownStreak;
      totalKnown += result.known;
      totalSkippedPinned += result.skippedPinned;
      totalSkippedWrongAuthor += result.skippedWrongAuthor;
      totalValidSeen += result.added + result.known;

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
        requireFullKnownMatch,
        matchedKnownCount: totalKnown,
        totalKnownIds,
      });
      boundaryExtraScrollsRemaining = decision.boundaryExtraScrollsRemaining;
      noGrowth = decision.noGrowth;
      if (decision.hitSafetyCap) hitSafetyCap = true;

      if (decision.stop) {
        stopReason = decision.stopReason ?? stopReason;
        if (decision.stopReason === "max_new_posts_per_run_reached") {
          console.warn(
            JSON.stringify({ event: "scrape_safety_cap_reached", targetUser, maxNewPostsPerRun, collectedNewPosts: collected.size })
          );
        } else if (decision.stopReason === "stall_no_dom_growth") {
          console.warn(JSON.stringify({ event: "scrape_stall_stop", targetUser, scrollsPerformed }));
        }
        break;
      }

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
    }

    if (scrollsPerformed >= maxScrolls && stopReason === "max_scrolls_reached") {
      console.warn(
        JSON.stringify({ event: "scrape_max_scrolls_reached", targetUser, maxScrolls, collectedNewPosts: collected.size })
      );
    }

    if (!isDiffMode && collected.size < initialTargetCount) {
      console.warn(`[fetch] 有効件数が目標未満: ${collected.size}/${initialTargetCount}（別ユーザー・固定投稿除外後）`);
    }

    const sorted = [...collected.values()].sort((a, b) => {
      const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return tb - ta;
    });

    // 初回モードのみ maxPosts で切り詰める（差分モードは安全上限までに集まった新規分を全件返す）
    const posts = isDiffMode ? sorted : sorted.slice(0, initialTargetCount);

    // 差分モードで「既知境界まで安全に到達し、安全マージンも完了した」と確認できた場合のみ
    // 走査完了とみなす。それ以外の停止理由（安全上限到達／MAX_SCROLLS到達／stall）は
    // いずれも境界未確認のまま止まっているため走査未完了として扱う。
    const needsRecovery = isDiffMode && stopReason !== "known_streak_boundary_with_margin";

    const stats: FetchStats = {
      mode: isDiffMode ? "diff" : "initial",
      recoveryMode: requireFullKnownMatch,
      scrollsPerformed,
      targetUserPostsSeen: totalValidSeen,
      knownPosts: totalKnown,
      newPosts: posts.length,
      skippedPinned: totalSkippedPinned,
      skippedWrongAuthor: totalSkippedWrongAuthor,
      hitSafetyCap,
      stopReason,
      needsRecovery,
    };

    console.log(JSON.stringify({ event: "scrape_fetch_stats", targetUser, ...stats }));

    return { posts, stats };
  } finally {
    await context.close();
    await browser.close();
  }
}
