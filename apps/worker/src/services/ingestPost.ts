import { IngestPayloadSchema } from "@x-post/shared";
import type { ZodIssue } from "zod";
import type { Db } from "../db/client.ts";
import { upsertSourcePost } from "../repositories/sourcePostRepository.ts";
import { persistAnalysis } from "../repositories/analysisRepository.ts";

export interface IngestPostAnalysisResult {
  action: string;
  lotteryCount: number;
  lotteryResults?: unknown[];
}

export type IngestPostResult =
  | {
      ok: true;
      action: "inserted" | "updated" | "unchanged";
      sourcePostId: number;
      externalPostId: string;
      archivedAt: string | null;
      analysis?: IngestPostAnalysisResult;
      /** POST /ingest のログ出力用（DB保存結果には含めない）。 */
      logFields: {
        batchId: string | null;
        postType: string | null;
        isLotteryInformation: boolean | null;
        analysisStatus: string | null;
        extractedLotteryCount: number;
      };
    }
  | { ok: false; kind: "validation_failed"; issues: ZodIssue[] }
  | { ok: false; kind: "server_error"; message: string };

/**
 * `/ingest`・`/admin/claude-ingest`の両方が呼ぶ共通処理。
 * sourcePostのupsertとanalysisの永続化（lottery matching含む）を1件分行う。
 * ルート固有の責務（認証・リクエストボディのJSONパース・HTTPレスポンス構築）は呼び出し側で行う。
 */
export async function ingestPost(db: Db, payload: unknown): Promise<IngestPostResult> {
  const parsed = IngestPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, kind: "validation_failed", issues: parsed.error.issues };
  }

  let result;
  try {
    result = await upsertSourcePost(db, parsed.data.sourcePost);
  } catch (e) {
    return { ok: false, kind: "server_error", message: e instanceof Error ? e.message : String(e) };
  }

  // アーカイブ済みsourcePostはlottery解析・再解析の対象外（要件: archivedから新規lottery/candidateを作らない）。
  let analysis: IngestPostAnalysisResult | undefined;
  if (parsed.data.analysis && result.archivedAt) {
    analysis = { action: "skipped_archived", lotteryCount: 0 };
  } else if (parsed.data.analysis) {
    try {
      analysis = await persistAnalysis(db, result.sourcePostId, parsed.data.analysis);
    } catch (e) {
      analysis = { action: "failed", lotteryCount: 0 };
      console.error(`[ingestPost] analysis 永続化失敗: ${e instanceof Error ? e.message : e}`);
    }
  }

  return {
    ok: true,
    action: result.action,
    sourcePostId: result.sourcePostId,
    externalPostId: result.externalPostId,
    archivedAt: result.archivedAt,
    ...(analysis ? { analysis } : {}),
    logFields: {
      batchId: parsed.data.batchId ?? null,
      postType: parsed.data.analysis?.postType ?? null,
      isLotteryInformation: parsed.data.analysis?.isLotteryInformation ?? null,
      analysisStatus: parsed.data.analysis?.analysisStatus ?? null,
      extractedLotteryCount: parsed.data.analysis?.extractedLotteries?.length ?? 0,
    },
  };
}
