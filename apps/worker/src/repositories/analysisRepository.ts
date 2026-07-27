import { eq } from "drizzle-orm";
import type { AnalysisInput } from "@x-post/shared";
import type { Db } from "../db/client.ts";
import { lotteries, postAnalyses, type PostAnalysisRow } from "../db/schema.ts";
import { syncLotteriesFromAnalysis, toLotteryRow, type LotteryActionResult } from "./lotteryRepository.ts";

export interface PersistAnalysisResult {
  action: "inserted" | "reused" | "failed";
  lotteryCount: number;
  lotteryResults?: LotteryActionResult[];
}

/**
 * 再解析判定（純関数・ルールベース）。
 * 判定キーは inputContentHash（= source_posts.content_hash）と parserVersion の2つ:
 *  - 同一 sourcePost に inputContentHash と parserVersion が両方一致する解析があれば reused（再解析しない）。
 *  - 本文（contentHash）が変わった場合、または parserVersion が変わった（解析ロジックが改善された）場合は
 *    一致する既存が無いので inserted（必ず再解析）。
 */
export function decideAnalysisAction(priors: PostAnalysisRow[], incoming: AnalysisInput): "reused" | "inserted" {
  const exists = priors.some(
    (p) =>
      (p.inputContentHash ?? null) === (incoming.inputContentHash ?? null) &&
      (p.parserVersion ?? null) === (incoming.parserVersion ?? null)
  );
  return exists ? "reused" : "inserted";
}

async function priorSourceLotteryCount(db: Db, sourcePostId: number): Promise<number> {
  const existing = await db.select().from(lotteries).where(eq(lotteries.sourcePostId, sourcePostId));
  return existing.length;
}

/**
 * 解析結果を永続化する。
 *  - reused: inputContentHash と parserVersion が両方一致する解析が既にあれば post_analyses・lotteries を変更しない。
 *  - inserted: contentHash が変わった / parserVersion が上がった / 初回 → post_analyses を追加し、抽選候補を
 *    **同一抽選マッチング（match → merge / insert）**で永続化する（Phase 3）。統合・履歴・情報源は Worker 責務。
 */
export async function persistAnalysis(
  db: Db,
  sourcePostId: number,
  analysis: AnalysisInput
): Promise<PersistAnalysisResult> {
  const priors = await db.select().from(postAnalyses).where(eq(postAnalyses.sourcePostId, sourcePostId));

  if (decideAnalysisAction(priors, analysis) === "reused") {
    return { action: "reused", lotteryCount: await priorSourceLotteryCount(db, sourcePostId) };
  }

  const now = new Date().toISOString();
  await db.insert(postAnalyses).values({
    sourcePostId,
    postType: analysis.postType,
    isLotteryInformation: analysis.isLotteryInformation,
    cardType: analysis.cardType,
    confidenceScore: String(analysis.confidenceScore),
    analysisStatus: analysis.analysisStatus,
    parserVersion: analysis.parserVersion,
    inputContentHash: analysis.inputContentHash,
    extractedData: JSON.stringify({ lotteries: analysis.extractedLotteries, urls: analysis.urls }),
    analyzedAt: now,
    errorMessage: analysis.errorMessage ?? null,
  });

  // Phase 3: 同一抽選マッチングで統合 / 新規登録し、情報源・変更履歴を記録する。
  const candidates = analysis.extractedLotteries.map((l) => toLotteryRow(sourcePostId, l));
  const synced = await syncLotteriesFromAnalysis(db, sourcePostId, candidates);
  return { action: "inserted", lotteryCount: synced.count, lotteryResults: synced.results };
}
