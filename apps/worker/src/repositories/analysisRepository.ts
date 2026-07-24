import { eq } from "drizzle-orm";
import type { AnalysisInput, ExtractedLottery } from "@x-post/shared";
import type { Db } from "../db/client.ts";
import { lotteries, postAnalyses, type PostAnalysisRow } from "../db/schema.ts";
import {
  NORMALIZER_VERSION,
  normalizeProductName,
  normalizeStoreBranch,
  normalizeStoreName,
} from "../services/normalize.ts";

export interface PersistAnalysisResult {
  action: "inserted" | "reused" | "failed";
  lotteryCount: number;
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

/** completenessScore（0-1）: 商品/店舗=必須, 締切/当選/URL=重要 */
function completeness(l: ExtractedLottery): number {
  let s = 0;
  if (l.productNameRaw) s += 0.25;
  if (l.storeNameRaw) s += 0.25;
  if (l.applicationEnd.at || l.applicationEnd.date) s += 0.2;
  if (l.resultAnnouncement.at || l.resultAnnouncement.date) s += 0.15;
  if (l.applicationUrl) s += 0.15;
  return Number(s.toFixed(2));
}

/** 日時項目に conflicting があれば verificationStatus=conflicting */
function verification(l: ExtractedLottery): string {
  const fields = [l.applicationStart, l.applicationEnd, l.resultAnnouncement, l.purchaseStart, l.purchaseDeadline];
  return fields.some((f) => f.status === "conflicting") ? "conflicting" : "extracted";
}

function toLotteryRow(sourcePostId: number, l: ExtractedLottery) {
  return {
    sourcePostId,
    productNameRaw: l.productNameRaw,
    normalizedProductName: normalizeProductName(l.productNameRaw),
    cardType: l.cardType,
    storeNameRaw: l.storeNameRaw,
    normalizedStoreName: normalizeStoreName(l.storeNameRaw),
    storeBranchRaw: l.storeBranchRaw,
    normalizedStoreBranch: normalizeStoreBranch(l.storeBranchRaw),
    region: l.region,
    normalizerVersion: NORMALIZER_VERSION,
    applicationStartAt: l.applicationStart.at ?? l.confirmedOpenAt,
    confirmedOpenAt: l.confirmedOpenAt,
    applicationEndAt: l.applicationEnd.at,
    applicationEndDate: l.applicationEnd.date,
    applicationEndPrecision: l.applicationEnd.precision,
    resultAnnouncementAt: l.resultAnnouncement.at,
    resultAnnouncementDate: l.resultAnnouncement.date,
    resultAnnouncementPrecision: l.resultAnnouncement.precision,
    purchaseStartAt: l.purchaseStart.at,
    purchaseDeadlineAt: l.purchaseDeadline.at ?? l.purchaseDeadline.date,
    applicationUrl: l.applicationUrl,
    officialInformationUrl: l.officialInformationUrl,
    appDownloadUrl: l.appDownloadUrl,
    applicationMethod: l.applicationMethod,
    eligibilityConditions: l.eligibilityConditions,
    pickupMethod: l.pickupMethod,
    paymentMethod: l.paymentMethod,
    price: l.price,
    status: "open",
    completenessScore: String(completeness(l)),
    verificationStatus: verification(l),
  };
}

async function currentLotteryCount(db: Db, sourcePostId: number): Promise<number> {
  const existing = await db.select().from(lotteries).where(eq(lotteries.sourcePostId, sourcePostId));
  return existing.length;
}

/**
 * 解析結果を永続化する。
 *  - reused: inputContentHash と parserVersion が両方一致する解析が既にあれば post_analyses・lotteries を変更しない。
 *  - inserted: contentHash が変わった / parserVersion が上がった / 初回 → post_analyses を追加し、当該 sourcePost の
 *    lotteries を作り直す（Phase 2 は単純 insert。同一判定・統合は Phase 3）。
 */
export async function persistAnalysis(
  db: Db,
  sourcePostId: number,
  analysis: AnalysisInput
): Promise<PersistAnalysisResult> {
  const priors = await db.select().from(postAnalyses).where(eq(postAnalyses.sourcePostId, sourcePostId));

  if (decideAnalysisAction(priors, analysis) === "reused") {
    return { action: "reused", lotteryCount: await currentLotteryCount(db, sourcePostId) };
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

  // 再解析時は当該 sourcePost の抽選を作り直す（Phase 3 で統合方式に置き換える）
  await db.delete(lotteries).where(eq(lotteries.sourcePostId, sourcePostId));
  let count = 0;
  for (const l of analysis.extractedLotteries) {
    await db.insert(lotteries).values(toLotteryRow(sourcePostId, l));
    count++;
  }
  return { action: "inserted", lotteryCount: count };
}
