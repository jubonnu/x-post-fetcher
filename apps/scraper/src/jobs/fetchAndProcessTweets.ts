import { computeContentHash, type IngestPayload, type SourcePostInput } from "@x-post/shared";
import { fetchTweets } from "../scraping/x/fetchTweets.ts";
import type { RawPost } from "../scraping/x/parseTweetDom.ts";
import { analyzePost } from "../lottery/analyzePost.ts";
import { classifyEntryPurpose, type EntryPurpose } from "../lottery/entryPurpose.ts";

/**
 * バッチ: X を取得 → sourcePost payload を組み立て → Worker の /ingest へ POST。
 * Phase 1 は解析（analysis）を送らず、生投稿のみを登録する。
 *
 * 取得方式（前回取得済み地点までプロフィールを遡る差分取得）:
 *   実行開始時に Worker の GET /internal/source-posts/known-external-ids で
 *   TARGET_USER の既知 externalPostId 一覧を取得し、fetchTweets へ渡す。
 *   既知IDが1件もなければ（初回起動）従来どおり最新 MAX_POSTS 件を取得する。
 *
 *   既知ID照会そのものが失敗した場合（タイムアウト・404・500・レスポンス形式不正等）は、
 *   初回モードへフォールバックせず本バッチ全体を失敗させる（スクレイプ・ingestを一切行わない）。
 *   フォールバックすると「短時間に多数投稿された場合の取りこぼし防止」という差分取得の目的自体が
 *   崩れるため（1時間に15件以上投稿された場合、初回モード=MAX_POSTS件しか見ないと確実に欠落する）。
 *   失敗時はGitHub Actionsがfailureになり、次回cronで再試行される。
 *
 *   走査結果が「既知投稿の境界まで安全に到達し、安全マージンも完了した」と確認できなかった場合
 *   （安全上限到達／既知境界未確認のままMAX_SCROLLS到達／既知境界未確認のままstall）は
 *   「走査未完了（needsRecovery）」として扱う。この場合、新規投稿をingestするより前に
 *   Workerへ needsRecovery=true と recovery cursor（今回どこまで遡ったか）を確実に保存し、
 *   保存に失敗したらingest自体を行わずバッチを失敗させる（走査未完了の事実を記録し損ねたまま
 *   新規投稿だけが既知化されると、次回が誤って通常モードに戻り取りこぼす致命的な経路になるため）。
 *   保存に成功した場合のみ、続けてingestする。
 *
 *   recovery cursor方式（2026-08〜）: 次回実行は「knownExternalPostIds全件との一致」ではなく
 *   「前回保存されたcursor地点（externalPostId一致 or publishedAtがcursor以前）に到達するまで」
 *   known-streakの早期停止を抑制する。全件一致を要求する方式は、known IDセットが大きくなるほど
 *   （X側のプロフィールスクロールが実際にDOMへ出せる深さを超えると）needsRecoveryが永久に
 *   収束しなくなる欠陥があったため廃止した。cursorは`mergeRecoveryCursor`で単調（古い方向へのみ）
 *   に更新され、今回cursorに到達できなかった場合は既存cursorを保持する（後退しない）。
 *   archive済み（archivedAt付き）のsource_postもknown IDとしては扱われるが、cursor到達判定の
 *   母数には一切影響しない（archive件数が多くてもrecoveryは収束できる）。
 *
 *   逆に走査完了（stopReasonが"known_streak_boundary_with_margin"）の場合は、ingest成功後に
 *   needsRecovery=false・cursor解除（null）を試みる（ベストエフォート。失敗しても次回も
 *   recoveryモードに留まるだけで、取りこぼし方向には倒れないため安全）。
 *
 *   安全上限に到達しない・走査完了の実行が1回できるまでこれを繰り返すことで、複数回の実行を
 *   通じて取りこぼしなく全件回収されることを保証する。
 *
 * 環境変数:
 *   INGEST_URL          … 例 http://localhost:8787/ingest（デフォルト）
 *   INGEST_TOKEN        … Bearer トークン（未設定なら送信せずドライラン。ローカル動作確認専用で、
 *                          この場合のみ既知ID照会自体を行わず初回モード相当で実行する）
 *   TARGET_USER         … 取得対象（デフォルト Zabi_pokeka）
 *   MAX_POSTS           … 初回起動時のみ有効な目標件数（デフォルト 14）。差分取得時は無視される
 *   MAX_NEW_POSTS_PER_RUN … 差分取得時の安全上限（デフォルト 200）
 *   MAX_SCROLLS         … 最大スクロール回数（デフォルト 60）
 *   KNOWN_IDS_LOOKBACK  … 既知ID照会時の取得件数上限（デフォルト 200。リカバリーモード中はWorker側で無視され全件返る）
 */

type KnownIdsLookupResult =
  | {
      ok: true;
      externalPostIds: Set<string>;
      needsRecovery: boolean;
      recoveryCursorExternalPostId: string | null;
      recoveryCursorPublishedAt: string | null;
    }
  | { ok: false; reason: string };

interface RecoveryCursorPoint {
  externalPostId: string;
  publishedAt: string;
}

/**
 * recovery cursorを単調（＝古い方向へのみ進む）にマージする。
 * 「knownExternalPostIds全件との一致」を要求する旧方式は、known IDセットが大きくなるほど
 * needsRecoveryが永久に収束しなくなる欠陥があったため、cursorは「前回の到達地点」という
 * 相対的なマイルストーンに置き換えた（2026-08）。このマージ関数がその中核: 今回の走査で
 * 到達した最古地点(candidate)が既存cursor(existing)より古ければ前進、そうでなければ
 * 既存cursorを保持する（今回cursorに到達できなかった場合の後退防止）。
 */
export function mergeRecoveryCursor(
  existing: RecoveryCursorPoint | null,
  candidate: RecoveryCursorPoint | null
): RecoveryCursorPoint | null {
  if (!candidate) return existing;
  if (!existing) return candidate;
  return Date.parse(candidate.publishedAt) < Date.parse(existing.publishedAt) ? candidate : existing;
}

interface IngestCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  failed: number;
}

async function buildSourcePost(p: RawPost): Promise<SourcePostInput> {
  return {
    platform: "x",
    externalPostId: p.tweetId,
    authorId: p.authorId,
    authorUsername: p.authorUsername,
    authorDisplayName: p.authorDisplayName,
    bodyRaw: p.bodyText,
    publishedAt: p.publishedAt,
    sourceUrl: p.sourceUrl,
    imageUrls: p.imageUrls,
    externalUrls: p.externalUrls,
    rawHtml: p.rawHtml,
    cleanedHtml: p.cleanedHtml,
    contentHash: await computeContentHash(p.bodyText),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Worker の GET /internal/source-posts/known-external-ids から既知 externalPostId 一覧と
 * リカバリーモード要否（needsRecovery）を取得する。
 * API障害（timeout/404/500/レスポンス形式不正等）は `{ ok: false }` として明示的に返し、
 * 呼び出し元でバッチ全体を失敗させる（初回モードへの暗黙フォールバックは行わない）。
 */
export async function fetchKnownExternalPostIds(baseUrl: string, token: string, targetUser: string, limit: number): Promise<KnownIdsLookupResult> {
  const url = new URL("/internal/source-posts/known-external-ids", baseUrl);
  url.searchParams.set("authorUsername", targetUser);
  url.searchParams.set("limit", String(limit));
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      return { ok: false, reason: `known-external-ids照会が失敗しました（status=${res.status}）` };
    }
    const json = (await res.json()) as {
      ok?: boolean;
      externalPostIds?: unknown;
      needsRecovery?: unknown;
      recoveryCursorExternalPostId?: unknown;
      recoveryCursorPublishedAt?: unknown;
    };
    if (!json.ok || !Array.isArray(json.externalPostIds)) {
      return { ok: false, reason: "known-external-idsのレスポンス形式が不正です" };
    }
    return {
      ok: true,
      externalPostIds: new Set(json.externalPostIds as string[]),
      needsRecovery: Boolean(json.needsRecovery),
      recoveryCursorExternalPostId: typeof json.recoveryCursorExternalPostId === "string" ? json.recoveryCursorExternalPostId : null,
      recoveryCursorPublishedAt: typeof json.recoveryCursorPublishedAt === "string" ? json.recoveryCursorPublishedAt : null,
    };
  } catch (e) {
    return { ok: false, reason: `known-external-ids照会でエラーが発生しました: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 今回の走査結果（needsRecovery / recovery cursor）をWorkerへ保存する。成功/失敗を呼び出し元へ返す
 * （failure時にバッチ全体を失敗させるかどうかは呼び出し元の責務で判断する。
 *  true保存の失敗はバッチ失敗に直結させ、false解除の失敗は警告に留める、という非対称な扱いのため）。
 * `cursor`省略時はWorker側でcursorを変更しない。`null`を渡すと明示的に解除する。
 */
async function saveScrapeRunResult(
  baseUrl: string,
  token: string,
  targetUser: string,
  needsRecovery: boolean,
  cursor?: RecoveryCursorPoint | null
): Promise<boolean> {
  const url = new URL("/internal/source-posts/scrape-run-result", baseUrl);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        authorUsername: targetUser,
        needsRecovery,
        ...(cursor !== undefined
          ? {
              recoveryCursorExternalPostId: cursor?.externalPostId ?? null,
              recoveryCursorPublishedAt: cursor?.publishedAt ?? null,
            }
          : {}),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

interface IngestOneResult {
  lotteryResults: { matchAction?: string }[];
}

/** 1件のsourcePostをWorkerへingestする（解析→送信）。1件の失敗でバッチ全体は止めない。 */
async function ingestOne(
  ingestUrl: string,
  token: string,
  batchId: string,
  p: RawPost,
  counts: IngestCounts
): Promise<IngestOneResult | null> {
  let analysis: IngestPayload["analysis"] = null;
  try {
    analysis = await analyzePost(p);
  } catch (e) {
    console.warn(`[scrape] tweetId=${p.tweetId} 解析失敗（生投稿のみ送信）: ${e instanceof Error ? e.message : e}`);
  }
  const payload: IngestPayload = { batchId, sourcePost: await buildSourcePost(p), analysis };
  try {
    const res = await fetch(ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    interface IngestResponse {
      ok?: boolean;
      error?: string;
      action?: string;
      sourcePostId?: number;
      analysis?: { action?: string; lotteryResults?: { matchAction?: string }[] };
    }
    const json: IngestResponse = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      counts.failed++;
      console.error(
        JSON.stringify({ batchId, tweetId: p.tweetId, action: "failed", httpStatus: res.status, error: json.error ?? "unknown" })
      );
      return null;
    }
    const action = json.action ?? "unknown";
    counts[action as keyof IngestCounts] = (counts[action as keyof IngestCounts] ?? 0) + 1;
    console.log(
      JSON.stringify({
        batchId,
        tweetId: p.tweetId,
        sourcePostId: json.sourcePostId,
        action: json.action,
        postType: analysis?.postType ?? null,
        isLotteryInformation: analysis?.isLotteryInformation ?? null,
        analysisStatus: analysis?.analysisStatus ?? null,
        extractedLotteryCount: analysis?.extractedLotteries?.length ?? 0,
        analysisAction: json.analysis?.action ?? null,
        lotteryResults: json.analysis?.lotteryResults ?? [],
      })
    );
    return { lotteryResults: json.analysis?.lotteryResults ?? [] };
  } catch (e) {
    counts.failed++;
    console.error(`[scrape] tweetId=${p.tweetId} 送信エラー: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export async function main(): Promise<void> {
  const batchId = `batch_${Date.now()}`;
  const ingestUrl = process.env.INGEST_URL ?? "http://localhost:8787/ingest";
  const token = process.env.INGEST_TOKEN;
  const targetUser = process.env.TARGET_USER ?? "Zabi_pokeka";
  const maxPosts = Number(process.env.MAX_POSTS ?? 14);
  const maxNewPostsPerRun = Number(process.env.MAX_NEW_POSTS_PER_RUN ?? 200);
  const maxScrolls = Number(process.env.MAX_SCROLLS ?? 60);
  const knownIdsLookback = Number(process.env.KNOWN_IDS_LOOKBACK ?? 200);

  let knownExternalPostIds = new Set<string>();
  let existingCursor: RecoveryCursorPoint | null = null;

  if (token) {
    const lookup = await fetchKnownExternalPostIds(ingestUrl, token, targetUser, knownIdsLookback);
    if (!lookup.ok) {
      // 初回モードへフォールバックしない: 取りこぼしが増える方向を避けるため、
      // 既知IDと突合できない状態でのスクレイプ・ingestは一切行わずバッチを失敗させる。
      throw new Error(`known-external-idsの取得に失敗したため今回のスクレイプを中止しました: ${lookup.reason}`);
    }
    knownExternalPostIds = lookup.externalPostIds;
    existingCursor =
      lookup.recoveryCursorExternalPostId && lookup.recoveryCursorPublishedAt
        ? { externalPostId: lookup.recoveryCursorExternalPostId, publishedAt: lookup.recoveryCursorPublishedAt }
        : null;
    console.log(
      `[scrape] 既知投稿 ${knownExternalPostIds.size} 件と突合します（0件なら初回モード、リカバリーモード=${Boolean(existingCursor)}）`
    );
  }
  // token未設定（INGEST_TOKENなしのローカル動作確認）の場合のみ、既知ID照会自体を行わず
  // 初回モード相当（ドライラン）で続行する。本番cronでは必ずtokenが設定されている。

  const { posts, stats } = await fetchTweets({
    targetUser,
    maxPosts,
    knownExternalPostIds,
    maxNewPostsPerRun,
    maxScrolls,
    recoveryCursorExternalPostId: existingCursor?.externalPostId ?? null,
    recoveryCursorPublishedAt: existingCursor?.publishedAt ?? null,
  });
  console.log(`[scrape] batchId=${batchId} 取得 ${posts.length} 件 ${JSON.stringify(stats)}`);

  if (!token) {
    console.warn("[scrape] INGEST_TOKEN 未設定のためドライラン（送信しません）。");
    for (const p of posts) {
      const sp = await buildSourcePost(p);
      console.log(`[dryrun] ${sp.externalPostId} ${sp.publishedAt} hash=${sp.contentHash.slice(0, 8)}`);
    }
    return;
  }

  const isDiffMode = knownExternalPostIds.size > 0;

  // 走査未完了なら、新規投稿をingestするより前にWorkerへ needsRecovery=true と
  // 更新後のrecovery cursorを確実に保存する。保存に失敗した場合はingestを一切行わず
  // バッチを失敗させる（次回cronで再試行）。cursorは単調（古い方向へのみ）にマージするため、
  // 今回cursorに到達できなかった場合は既存cursorがそのまま維持される（後退しない）。
  if (isDiffMode && stats.needsRecovery) {
    const candidate: RecoveryCursorPoint | null =
      stats.oldestValidSeenExternalPostId && stats.oldestValidSeenPublishedAt
        ? { externalPostId: stats.oldestValidSeenExternalPostId, publishedAt: stats.oldestValidSeenPublishedAt }
        : null;
    const newCursor = mergeRecoveryCursor(existingCursor, candidate);
    const saved = await saveScrapeRunResult(ingestUrl, token, targetUser, true, newCursor);
    if (!saved) {
      throw new Error(
        "走査未完了（needsRecovery）状態の保存に失敗したため、今回のingestを中止しました。次回cronで今回未反映の新規投稿ごと再試行されます。"
      );
    }
  }

  const counts: IngestCounts = { inserted: 0, updated: 0, unchanged: 0, failed: 0 };
  const categoryCounts: Record<EntryPurpose, number> = { new_lottery: 0, summary: 0, result: 0, ignored: 0 };
  const ignoredExternalPostIds: string[] = [];
  let summaryNewCount = 0;
  let summarySkippedCount = 0;
  let resultCandidateCount = 0;

  for (const p of posts) {
    const entryPurpose = classifyEntryPurpose(p.bodyText);
    categoryCounts[entryPurpose]++;
    if (entryPurpose === "ignored") {
      ignoredExternalPostIds.push(p.tweetId);
      console.log(JSON.stringify({ event: "skippedByKeywordFilter", tweetId: p.tweetId }));
    }

    const ingestResult = await ingestOne(ingestUrl, token, batchId, p, counts);

    if (entryPurpose === "summary" && ingestResult) {
      for (const r of ingestResult.lotteryResults) {
        if (r.matchAction === "new") summaryNewCount++;
        else summarySkippedCount++; // candidate/own_updated/own_confirmed_skipped は「既存としてスキップ（候補化含む）」扱い
      }
    }
    if (entryPurpose === "result" && ingestResult) {
      for (const r of ingestResult.lotteryResults) {
        if (r.matchAction === "candidate") resultCandidateCount++;
      }
    }
  }

  console.log(
    JSON.stringify({
      event: "scrape_classification_summary",
      fetchedCount: posts.length,
      newLotteryCount: categoryCounts.new_lottery,
      summaryCount: categoryCounts.summary,
      resultCount: categoryCounts.result,
      ignoredCount: categoryCounts.ignored,
      ignoredExternalPostIds,
      summaryNewCount,
      summarySkippedCount,
      resultCandidateCount,
    })
  );

  console.log(
    `[scrape] 完了 inserted=${counts.inserted} updated=${counts.updated} unchanged=${counts.unchanged} failed=${counts.failed}`
  );

  // 走査完了（既知境界まで安全に到達）した場合のみ、ingest成功後にneedsRecoveryとcursorの解除を試みる。
  // 解除に失敗しても次回もrecoveryモードに留まるだけで安全側（取りこぼし方向には倒れない）。
  if (isDiffMode && !stats.needsRecovery) {
    const cleared = await saveScrapeRunResult(ingestUrl, token, targetUser, false, null);
    if (!cleared) {
      console.warn("[scrape] needsRecovery解除に失敗しました。次回もリカバリーモードで実行されます（安全側のフォールバック）。");
    }
  }
}

// CLI実行時のみ自動実行する（テストからimportした場合に副作用が起きないようにするため）。
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error("[scrape][error]", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
