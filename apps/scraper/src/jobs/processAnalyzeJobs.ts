/**
 * analyze_post ジョブ処理スクリプト。
 * Worker の GET /internal/jobs/next?type=analyze_post でジョブを取得し、
 * ルールベース再解析 → POST /ingest して完了 or 失敗を報告する。
 *
 * 環境変数:
 *   WORKER_URL    … 例 http://localhost:8787（デフォルト）
 *   INGEST_TOKEN  … Bearer トークン（必須）
 *   MAX_JOBS      … 1回の実行で処理する最大件数（デフォルト 10）
 */

import type { ExternalLink, RawPost } from "../scraping/x/parseTweetDom.ts";
import { analyzePost } from "../lottery/analyzePost.ts";
import { computeContentHash, type AnalysisInput } from "@x-post/shared";

const WORKER_URL = (process.env.WORKER_URL ?? "http://localhost:8787").replace(/\/$/, "");
const TOKEN = process.env.INGEST_TOKEN ?? "";
const MAX_JOBS = Number(process.env.MAX_JOBS ?? 10);

const AUTH_HEADERS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${TOKEN}`,
};

interface StoredSourcePost {
  id: number;
  externalPostId: string;
  bodyRaw: string | null;
  publishedAt: string | null;
  externalUrls: string[];
  imageUrls: string[];
  sourceUrl: string | null;
  contentHash: string | null;
}

interface JobResponse {
  jobId: number;
  jobType: string;
  sourcePostId: number | null;
  sourcePost: StoredSourcePost | null;
  parserVersion: string;
}

/** Worker から次の analyze_post ジョブを1件取得する。 */
async function fetchNextJob(): Promise<JobResponse | null> {
  const res = await fetch(`${WORKER_URL}/internal/jobs/next?type=analyze_post`, {
    headers: AUTH_HEADERS,
  });
  if (!res.ok) throw new Error(`GET /internal/jobs/next failed: ${res.status}`);
  const json = (await res.json()) as { ok: boolean; job: JobResponse | null };
  if (!json.ok) throw new Error(`jobs/next error: ${JSON.stringify(json)}`);
  return json.job;
}

/**
 * ルールベース解析を実行して AnalysisInput を生成する（LLM不使用）。
 * 実体は`analyzePost`（`lottery/analyzePost.ts`）に一本化してある。以前はここに同じ判定ロジックを
 * 重複実装していたが、片方だけ修正され挙動がズレる事故を防ぐため`analyzePost`を直接呼ぶように統一した
 * （2026-08）。DB保存済みの投稿を`RawPost`相当の形に詰め替えて渡す。
 */
async function reanalyze(sp: StoredSourcePost): Promise<AnalysisInput> {
  const externalLinks: ExternalLink[] = sp.externalUrls.map((href) => ({ href, text: href }));
  const rawPost: RawPost = {
    tweetId: sp.externalPostId,
    authorId: null,
    authorUsername: null,
    authorDisplayName: null,
    bodyText: sp.bodyRaw ?? "",
    publishedAt: sp.publishedAt,
    sourceUrl: sp.sourceUrl ?? "https://x.com",
    externalUrls: sp.externalUrls,
    externalLinks,
    imageUrls: sp.imageUrls,
    rawHtml: "",
    cleanedHtml: "",
  };
  return analyzePost(rawPost);
}

/** Worker の /ingest に解析結果を送信する。 */
async function postIngest(sp: StoredSourcePost, analysis: AnalysisInput): Promise<void> {
  const contentHash = sp.contentHash ?? (await computeContentHash(sp.bodyRaw ?? ""));
  const payload = {
    batchId: `reanalyze_${Date.now()}`,
    sourcePost: {
      platform: "x" as const,
      externalPostId: sp.externalPostId,
      bodyRaw: sp.bodyRaw ?? "",
      publishedAt: sp.publishedAt ?? null,
      sourceUrl: sp.sourceUrl ?? "https://x.com",
      externalUrls: sp.externalUrls,
      imageUrls: sp.imageUrls,
      rawHtml: "",
      cleanedHtml: "",
      authorId: null,
      authorUsername: null,
      authorDisplayName: null,
      contentHash,
      fetchedAt: new Date().toISOString(),
    },
    analysis,
  };

  const res = await fetch(`${WORKER_URL}/ingest`, {
    method: "POST",
    headers: AUTH_HEADERS,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST /ingest failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { ok: boolean };
  if (!json.ok) throw new Error(`/ingest error: ${JSON.stringify(json)}`);
}

async function reportComplete(jobId: number): Promise<void> {
  const res = await fetch(`${WORKER_URL}/internal/jobs/${jobId}/complete`, {
    method: "POST",
    headers: AUTH_HEADERS,
  });
  if (!res.ok) console.warn(`[analyze_jobs] complete report failed: ${res.status}`);
}

async function reportFail(jobId: number, error: string): Promise<void> {
  const res = await fetch(`${WORKER_URL}/internal/jobs/${jobId}/fail`, {
    method: "POST",
    headers: AUTH_HEADERS,
    body: JSON.stringify({ error }),
  });
  if (!res.ok) console.warn(`[analyze_jobs] fail report failed: ${res.status}`);
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error("[analyze_jobs] INGEST_TOKEN が未設定です。");
    process.exit(1);
  }

  console.log(`[analyze_jobs] 開始 WORKER_URL=${WORKER_URL} MAX_JOBS=${MAX_JOBS}`);
  let processed = 0;
  let failed = 0;

  for (let i = 0; i < MAX_JOBS; i++) {
    let job: JobResponse | null;
    try {
      job = await fetchNextJob();
    } catch (e) {
      console.error(`[analyze_jobs] ジョブ取得エラー: ${e instanceof Error ? e.message : e}`);
      break;
    }

    if (!job) {
      console.log("[analyze_jobs] ジョブなし（完了）");
      break;
    }

    const { jobId, sourcePost } = job;

    if (!sourcePost || !sourcePost.bodyRaw) {
      console.warn(`[analyze_jobs] jobId=${jobId} sourcePost なし → fail`);
      await reportFail(jobId, "sourcePost not found or bodyRaw empty");
      failed++;
      continue;
    }

    try {
      const analysis = await reanalyze(sourcePost);
      await postIngest(sourcePost, analysis);
      await reportComplete(jobId);
      console.log(
        JSON.stringify({
          jobId,
          sourcePostId: sourcePost.id,
          externalPostId: sourcePost.externalPostId,
          action: "completed",
          analysisStatus: analysis.analysisStatus,
          extractedLotteryCount: analysis.extractedLotteries?.length ?? 0,
        })
      );
      processed++;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[analyze_jobs] jobId=${jobId} 失敗: ${errMsg}`);
      await reportFail(jobId, errMsg);
      failed++;
    }
  }

  console.log(`[analyze_jobs] 完了 processed=${processed} failed=${failed}`);
}

main().catch((err) => {
  console.error("[analyze_jobs][error]", err instanceof Error ? err.message : err);
  process.exit(1);
});
