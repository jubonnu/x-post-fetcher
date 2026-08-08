import { computeContentHash, type IngestPayload, type SourcePostInput } from "@x-post/shared";
import { fetchTweets } from "../scraping/x/fetchTweets.ts";
import type { RawPost } from "../scraping/x/parseTweetDom.ts";
import { analyzePost } from "../lottery/analyzePost.ts";

/**
 * バッチ: X を取得 → sourcePost payload を組み立て → Worker の /ingest へ POST。
 * Phase 1 は解析（analysis）を送らず、生投稿のみを登録する。
 *
 * 環境変数:
 *   INGEST_URL   … 例 http://localhost:8787/ingest（デフォルト）
 *   INGEST_TOKEN … Bearer トークン（未設定なら送信せずドライラン）
 *   TARGET_USER  … 取得対象（デフォルト Zabi_pokeka）
 *   MAX_POSTS    … 取得件数（デフォルト 14）
 */

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

async function main(): Promise<void> {
  const batchId = `batch_${Date.now()}`;
  const ingestUrl = process.env.INGEST_URL ?? "http://localhost:8787/ingest";
  const token = process.env.INGEST_TOKEN;
  const targetUser = process.env.TARGET_USER ?? "Zabi_pokeka";
  const maxPosts = Number(process.env.MAX_POSTS ?? 14);

  const posts = await fetchTweets({ targetUser, maxPosts });
  console.log(`[scrape] batchId=${batchId} 取得 ${posts.length} 件`);

  if (!token) {
    console.warn("[scrape] INGEST_TOKEN 未設定のためドライラン（送信しません）。");
    for (const p of posts) {
      const sp = await buildSourcePost(p);
      console.log(`[dryrun] ${sp.externalPostId} ${sp.publishedAt} hash=${sp.contentHash.slice(0, 8)}`);
    }
    return;
  }

  const counts: Record<string, number> = { inserted: 0, updated: 0, unchanged: 0, failed: 0 };
  for (const p of posts) {
    // 解析（分類＋抽出）。1件の解析失敗でバッチを止めない（sourcePostは必ず送る）
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
        analysis?: { action?: string; lotteryResults?: unknown[] };
      }
      const json: IngestResponse = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        counts.failed++;
        // 構造化ログ（エラー）
        console.error(
          JSON.stringify({
            batchId,
            tweetId: p.tweetId,
            action: "failed",
            httpStatus: res.status,
            error: json.error ?? "unknown",
          })
        );
      } else {
        const action = json.action ?? "unknown";
        counts[action] = (counts[action] ?? 0) + 1;
        // 構造化ログ（正常）: rawHtml / cleanedHtml は含まない
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
      }
    } catch (e) {
      counts.failed++;
      console.error(`[scrape] tweetId=${p.tweetId} 送信エラー: ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log(
    `[scrape] 完了 inserted=${counts.inserted} updated=${counts.updated} unchanged=${counts.unchanged} failed=${counts.failed}`
  );
}

main().catch((err) => {
  console.error("[scrape][error]", err instanceof Error ? err.message : err);
  process.exit(1);
});
