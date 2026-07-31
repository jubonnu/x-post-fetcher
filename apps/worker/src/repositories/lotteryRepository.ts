import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import type { ExtractedLottery } from "@x-post/shared";
import type { Db, DbOrTx } from "../db/client.ts";
import {
  lotteries,
  lotteryFieldHistory,
  lotterySources,
  type LotteryRow,
  type LotterySourceRow,
  type LotteryFieldHistoryRow,
} from "../db/schema.ts";
import {
  NORMALIZER_VERSION,
  normalizeProductName,
  normalizeStoreBranch,
  normalizeStoreName,
} from "../services/normalize.ts";
import { matchExistingLottery, type MatchOptions } from "../services/matchExistingLottery.ts";
import { mergeLotteryData, type FieldChange } from "../services/mergeLotteryData.ts";
import { enqueueJob } from "./processingJobRepository.ts";

/**
 * approved 状態を needs_review に降格させる「重要フィールド」セット。
 * このフィールドに conflicting な変更がある場合のみ approved → needs_review となる。
 * 空欄補完・非競合更新・同一内容では approved を維持する。
 */
const APPROVED_CONFLICT_FIELDS = new Set([
  "productNameRaw", "normalizedProductName",
  "storeNameRaw", "normalizedStoreName",
  "storeBranchRaw", "normalizedStoreBranch",
  "applicationStartAt",
  "applicationEndDate",      // DATE_GROUPS は g.date のフィールド名で記録される
  "resultAnnouncementDate",  // 同上
  "purchaseDeadlineAt",
  "applicationUrl",
]);

/** 重要フィールドに競合（conflicting）な変更があるか判定する。 */
function hasImportantFieldConflict(changes: FieldChange[]): boolean {
  return changes.some((c) => c.changeType === "conflicting" && APPROVED_CONFLICT_FIELDS.has(c.fieldName));
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

/** ExtractedLottery を lotteries 行（正規化込み）へ変換する。 */
export function toLotteryRow(sourcePostId: number, l: ExtractedLottery) {
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

export interface LotteryActionResult {
  lotteryId: number;
  matchAction: string;
  matchScore: number;
  changedFields: string[];
}

export interface SyncLotteriesResult {
  count: number;
  merged: number;
  inserted: number;
  review: number;
  results: LotteryActionResult[];
}

/** 締切ブロック日数を環境変数から取得（既定は matchExistingLottery 側の 7 日）。 */
function matchOpts(): MatchOptions {
  const d = Number(process.env.MATCH_DEADLINE_BLOCK_DAYS);
  return Number.isFinite(d) && d > 0 ? { deadlineBlockDays: d } : {};
}

/** 新規 lottery 挿入時に「created」履歴を残す主要フィールド */
const CREATED_HISTORY_FIELDS: (keyof ReturnType<typeof toLotteryRow>)[] = [
  "normalizedProductName",
  "normalizedStoreName",
  "normalizedStoreBranch",
  "region",
  "applicationEndDate",
  "resultAnnouncementDate",
  "applicationUrl",
];

/**
 * この sourcePost がかつて寄与した抽選への貢献（sources / history）を取り消し、
 * 孤立した（どの source も残らない）抽選を sofft-delete（lifecycleStatus=orphaned）にする。
 * 物理削除は行わない。
 */
async function unlinkSourceContributions(db: Db, sourcePostId: number): Promise<void> {
  const prior = await db
    .select({ lotteryId: lotterySources.lotteryId })
    .from(lotterySources)
    .where(eq(lotterySources.sourcePostId, sourcePostId));
  const touchedIds = [...new Set(prior.map((r) => r.lotteryId))];

  await db.delete(lotterySources).where(eq(lotterySources.sourcePostId, sourcePostId));
  await db.delete(lotteryFieldHistory).where(eq(lotteryFieldHistory.sourcePostId, sourcePostId));

  if (touchedIds.length === 0) return;
  const remaining = await db
    .select({ lotteryId: lotterySources.lotteryId })
    .from(lotterySources)
    .where(inArray(lotterySources.lotteryId, touchedIds));
  const stillLinked = new Set(remaining.map((r) => r.lotteryId));
  const orphaned = touchedIds.filter((id) => !stillLinked.has(id));
  if (orphaned.length > 0) {
    const now = new Date().toISOString();
    await db
      .update(lotteries)
      .set({ lifecycleStatus: "orphaned", orphanedAt: now, updatedAt: now })
      .where(inArray(lotteries.id, orphaned));
  }
}

/**
 * 解析結果の抽選候補群を、同一抽選マッチング（match → merge / insert）で永続化する。
 * - merge: 既存抽選へ空欄補完・競合フラグ、`lottery_field_history` と `lottery_sources` を記録。
 * - new:   新規 `lotteries` 挿入 + created 履歴 + source。
 * - review: 新規挿入だが `verificationStatus = needs_review`（両方保持・要確認）。
 */
export async function syncLotteriesFromAnalysis(
  db: Db,
  sourcePostId: number,
  candidates: ReturnType<typeof toLotteryRow>[]
): Promise<SyncLotteriesResult> {
  await unlinkSourceContributions(db, sourcePostId);

  const result: SyncLotteriesResult = { count: 0, merged: 0, inserted: 0, review: 0, results: [] };
  const opts = matchOpts();

  for (const candidate of candidates) {
    const existing: LotteryRow[] = await db.select().from(lotteries);
    const m = matchExistingLottery(candidate, existing, opts);

    if (m.action === "merge" && m.matchedIndex !== null) {
      const target = existing[m.matchedIndex];

      // rejected は自動取込で一切変更しない
      if (target.verificationStatus === "rejected") {
        continue;
      }

      const merged = mergeLotteryData(target as unknown as Record<string, string | null>, candidate as unknown as Record<string, string | null>);
      // approved は「重要フィールドへの競合」がある場合のみ needs_review に降格する。
      // 同一内容・空欄補完・非重要フィールドの更新では approved を維持する。
      // approvedBy / approvedAt は競合時も監査情報として維持する（SET 句に含めない）。
      const newVerificationStatus =
        target.verificationStatus === "approved"
          ? hasImportantFieldConflict(merged.changes) ? "needs_review" : "approved"
          : merged.verificationStatus;
      // orphaned lottery が再び source と一致したら active に戻す（rejected 以外）
      const lifecycleUpdate =
        target.lifecycleStatus !== "active" ? { lifecycleStatus: "active", orphanedAt: null } : {};

      const needsUpdate =
        Object.keys(merged.updates).length > 0 ||
        merged.hasConflict ||
        Object.keys(lifecycleUpdate).length > 0 ||
        newVerificationStatus !== target.verificationStatus;

      if (needsUpdate) {
        await db
          .update(lotteries)
          .set({ ...merged.updates, verificationStatus: newVerificationStatus, ...lifecycleUpdate, updatedAt: new Date().toISOString() })
          .where(eq(lotteries.id, target.id));
      }
      for (const c of merged.changes) {
        await db.insert(lotteryFieldHistory).values({
          lotteryId: target.id,
          sourcePostId,
          fieldName: c.fieldName,
          oldValue: c.oldValue,
          newValue: c.newValue,
          changeType: c.changeType,
        });
      }
      await db.insert(lotterySources).values({
        lotteryId: target.id,
        sourcePostId,
        matchAction: "merge",
        matchScore: String(m.score),
        matchReason: m.reason,
        contributedFields: JSON.stringify(merged.changes.map((c) => c.fieldName)),
      });
      // URL 解決ジョブをエンキュー（applicationUrl がある場合のみ）
      const mergedUrl = (merged.updates as Record<string, unknown>).applicationUrl ?? target.applicationUrl;
      if (mergedUrl) await enqueueJob(db, "resolve_urls", { lotteryId: target.id });
      result.results.push({
        lotteryId: target.id,
        matchAction: "merge",
        matchScore: m.score,
        changedFields: merged.changes.map((c) => c.fieldName),
      });
      result.merged++;
    } else {
      const isReview = m.action === "review";
      const row = { ...candidate, verificationStatus: isReview ? "needs_review" : candidate.verificationStatus };
      const [inserted] = await db.insert(lotteries).values(row).returning({ id: lotteries.id });
      const lotteryId = inserted.id;
      for (const f of CREATED_HISTORY_FIELDS) {
        const v = candidate[f];
        if (v != null && String(v).length > 0) {
          await db.insert(lotteryFieldHistory).values({
            lotteryId,
            sourcePostId,
            fieldName: f,
            oldValue: null,
            newValue: String(v),
            changeType: "created",
          });
        }
      }
      await db.insert(lotterySources).values({
        lotteryId,
        sourcePostId,
        matchAction: m.action,
        matchScore: String(m.score),
        matchReason: m.reason,
        contributedFields: JSON.stringify(CREATED_HISTORY_FIELDS.filter((f) => candidate[f] != null)),
      });
      // URL 解決ジョブをエンキュー（applicationUrl がある場合のみ）
      if (candidate.applicationUrl) await enqueueJob(db, "resolve_urls", { lotteryId });
      result.results.push({
        lotteryId,
        matchAction: m.action,
        matchScore: m.score,
        changedFields: CREATED_HISTORY_FIELDS.filter((f) => candidate[f] != null),
      });
      if (isReview) result.review++;
      else result.inserted++;
    }
    result.count++;
  }

  return result;
}

// ---- Phase 5: 公開/管理 API 用クエリ ----

export interface ListLotteriesOptions {
  cardType?: string;
  verificationStatus?: string;
  limit?: number;
  offset?: number;
}

export interface ListLotteriesResult {
  lotteries: LotteryRow[];
  total: number;
}

/** 公開 GET /lotteries 用の一覧取得（ページネーション + フィルタ）。
 * デフォルトで rejected + orphaned/archived を除外する。
 */
export async function listLotteries(db: DbOrTx, opts: ListLotteriesOptions = {}): Promise<ListLotteriesResult> {
  const { cardType, verificationStatus, limit = 20, offset = 0 } = opts;

  const conditions = [
    // rejected は公開しない
    ne(lotteries.verificationStatus, "rejected"),
    // orphaned / archived は公開しない
    eq(lotteries.lifecycleStatus, "active"),
    ...(cardType ? [eq(lotteries.cardType, cardType)] : []),
    ...(verificationStatus ? [eq(lotteries.verificationStatus, verificationStatus)] : []),
  ];
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(lotteries)
      .where(where)
      .orderBy(desc(lotteries.createdAt))
      .limit(Math.min(limit, 100))
      .offset(offset),
    db.select({ total: count() }).from(lotteries).where(where),
  ]);


  return { lotteries: rows, total };
}

export interface LotteryWithDetails {
  lottery: LotteryRow;
  sources: LotterySourceRow[];
  fieldHistory: LotteryFieldHistoryRow[];
}

/** 指定したlotteryIdが存在するか（Mobile-G2B-2: /me/lotteries系の所有者データ登録前チェック用）。 */
export async function lotteryExists(db: DbOrTx, lotteryId: number): Promise<boolean> {
  const rows = await db.select({ id: lotteries.id }).from(lotteries).where(eq(lotteries.id, lotteryId));
  return rows.length > 0;
}

/** 抽選の詳細（lottery_sources + lottery_field_history 付き）を取得する。 */
export async function getLotteryWithDetails(db: DbOrTx, id: number): Promise<LotteryWithDetails | null> {
  const rows = await db.select().from(lotteries).where(eq(lotteries.id, id));
  if (rows.length === 0) return null;

  const [sources, fieldHistory] = await Promise.all([
    db.select().from(lotterySources).where(eq(lotterySources.lotteryId, id)).orderBy(asc(lotterySources.createdAt)),
    db
      .select()
      .from(lotteryFieldHistory)
      .where(eq(lotteryFieldHistory.lotteryId, id))
      .orderBy(asc(lotteryFieldHistory.createdAt)),
  ]);

  return { lottery: rows[0], sources, fieldHistory };
}
