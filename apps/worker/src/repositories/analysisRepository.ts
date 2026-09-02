import { desc, eq } from "drizzle-orm";
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

/**
 * 指定sourcePostIdの最新解析（analyzedAt/id降順）のparserVersionを返す。無ければnull。
 * 更新候補の自動判定（Claude in Chrome由来かどうかの判定）に使う（services/autoResolveLotteryUpdateCandidates.ts）。
 */
export async function getLatestParserVersion(db: Db, sourcePostId: number): Promise<string | null> {
  const rows = await db
    .select({ parserVersion: postAnalyses.parserVersion })
    .from(postAnalyses)
    .where(eq(postAnalyses.sourcePostId, sourcePostId))
    .orderBy(desc(postAnalyses.id))
    .limit(1);
  return rows[0]?.parserVersion ?? null;
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
 *
 * post_analyses の追加と抽選候補の同期（syncLotteriesFromAnalysis）は1つのトランザクションに
 * まとめる。同期処理が候補の途中（例: 大量の候補を含むsummary投稿）で例外を投げた場合、
 * post_analyses の行だけがanalysisStatus="success"で残ってしまうと、以後の再スクレイプが
 * inputContentHash+parserVersion一致で「reused」判定してしまい、未処理分の候補が永久に
 * 取りこぼされる（2026-08、staging実データで実際に発生した事故）。トランザクション全体を
 * ロールバックすることで、失敗時は post_analyses の行自体が存在しない状態に戻り、次回の
 * 再スクレイプ（同一内容の再送）で必ず最初からやり直される。
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
  return db.transaction(async (tx) => {
    await tx.insert(postAnalyses).values({
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
    // analysisStatus === "needs_review"（複数抽選の分割失敗・低信頼抽出）は、toLotteryRowが
    // 日付競合のみで判定する verificationStatus（デフォルト "extracted"）に埋もれてしまうため、
    // ここで明示的に "needs_review" へ引き上げる（"conflicting" 等より詳細な状態は維持する）。
    const candidates = analysis.extractedLotteries.map((l) => {
      const row = toLotteryRow(sourcePostId, l);
      if (analysis.analysisStatus === "needs_review" && row.verificationStatus === "extracted") {
        return { ...row, verificationStatus: "needs_review" };
      }
      return row;
    });
    // まとめ投稿（lottery_summary）は「取りこぼした新規抽選の補完」が目的のため、既存と明確に
    // 同一（matchExistingLotteryのmerge閾値以上）の項目はupdate_candidateすら作らずスキップする。
    // 毎日のまとめ投稿から新規情報の無い重複update_candidateが大量発生することを防ぐため。
    const synced = await syncLotteriesFromAnalysis(tx, sourcePostId, candidates, {
      skipOnClearMatch: analysis.postType === "lottery_summary",
    });
    return { action: "inserted" as const, lotteryCount: synced.count, lotteryResults: synced.results };
  });
}
