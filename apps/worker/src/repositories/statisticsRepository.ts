import { and, asc, eq, isNull } from "drizzle-orm";
import type { DbOrTx } from "../db/client.ts";
import { lotteries, userLotteries, userLotteryStatusHistory } from "../db/schema.ts";
import {
  computeWinRate,
  lastNMonthsJst,
  reconstructAttempts,
  toJstYearMonth,
  type LotteryAttempt,
  type StatusHistoryEvent,
} from "../services/lotteryAttempts.ts";
import type { LotteryStatus } from "../services/lotteryStatusTransitions.ts";

/**
 * 統計API（Mobile-G6、premium必須）の集計ロジック。
 *
 * 2026-08の仕様変更: 「lotteryIdの現在ステータス」単位の集計から、
 * 「1回の応募試行（application attempt）」単位の集計へ変更した（`services/lotteryAttempts.ts`）。
 * 見送り後の再応募・訂正入力などで同一lotteryIdが複数回の試行を持ちうるため、
 * lotteryId単位で重複排除するのではなく、履歴から再構築した試行ごとに数える。
 * summary/monthly/storesはすべてこの同じ再構築結果を入力として使う。
 *
 * `deletedAt`の扱い: `GET /me/lotteries`一覧と一貫させるため、`deletedAt IS NULL`（現在保存中の
 * 抽選のみ）を対象にする。
 */

/** `userLotteryId`ごとの履歴を`id`昇順（実発生順）で取得する。deletedAtの有効行のみが対象。 */
async function fetchAttemptsForUser(db: DbOrTx, userId: number): Promise<LotteryAttempt[]> {
  const rows = await db
    .select({
      userLotteryId: userLotteryStatusHistory.userLotteryId,
      fromStatus: userLotteryStatusHistory.fromStatus,
      toStatus: userLotteryStatusHistory.toStatus,
      changedAt: userLotteryStatusHistory.changedAt,
    })
    .from(userLotteryStatusHistory)
    .innerJoin(userLotteries, eq(userLotteries.id, userLotteryStatusHistory.userLotteryId))
    .where(and(eq(userLotteries.userId, userId), isNull(userLotteries.deletedAt)))
    .orderBy(asc(userLotteryStatusHistory.id));

  const events: StatusHistoryEvent[] = rows.map((row) => ({
    lotteryId: row.userLotteryId,
    fromStatus: row.fromStatus as LotteryStatus | null,
    toStatus: row.toStatus as LotteryStatus,
    changedAt: row.changedAt,
  }));

  return reconstructAttempts(events);
}

export interface StatisticsSummary {
  savedCount: number;
  plannedCount: number;
  appliedCount: number;
  notAppliedCount: number;
  wonCount: number;
  lostCount: number;
  /** 結果がまだ確定していない試行数（応募数には含むが、当選率の分母には含まない）。 */
  pendingResultCount: number;
  /** 当選確定後、購入済みとして記録された試行数。 */
  purchasedCount: number;
  /** 当選確定後、購入を見送ったとして記録された試行数（応募自体を見送った件数ではない）。 */
  skippedCount: number;
  /** wonCount / (wonCount + lostCount)。分母0（結果が出た件が無い）ならnull（「計算不可」）。 */
  winRate: number | null;
}

export async function getStatisticsSummary(db: DbOrTx, userId: number): Promise<StatisticsSummary> {
  // savedCount/plannedCount/notAppliedCountは「現在保存している抽選の状態」を表す
  // スナップショット値であり、応募試行の集計対象ではないため従来通りuser_lotteries.statusから出す。
  const savedRows = await db
    .select({ status: userLotteries.status })
    .from(userLotteries)
    .where(and(eq(userLotteries.userId, userId), isNull(userLotteries.deletedAt)));

  const attempts = await fetchAttemptsForUser(db, userId);
  const wonCount = attempts.filter((a) => a.result === "won").length;
  const lostCount = attempts.filter((a) => a.result === "lost").length;
  const pendingResultCount = attempts.filter((a) => a.result === null).length;

  return {
    savedCount: savedRows.length,
    plannedCount: savedRows.filter((r) => r.status === "planned").length,
    appliedCount: attempts.length,
    notAppliedCount: savedRows.filter((r) => r.status === "unknown" || r.status === "planned").length,
    wonCount,
    lostCount,
    pendingResultCount,
    purchasedCount: attempts.filter((a) => a.purchaseState === "purchased").length,
    skippedCount: attempts.filter((a) => a.purchaseState === "skipped").length,
    winRate: computeWinRate(attempts),
  };
}

export interface MonthlyStatisticsItem {
  /** JST基準の年月（例: "2026-08"）。 */
  month: string;
  /** その月に開始した応募試行数（基準日時: 試行開始日時）。 */
  appliedCount: number;
  /** その月に結果がwon確定した試行数（基準日時: 結果確定日時）。 */
  wonCount: number;
  /** その月に結果がlost確定した試行数（基準日時: 結果確定日時）。 */
  lostCount: number;
  winRate: number | null;
}

export async function getStatisticsMonthly(
  db: DbOrTx,
  userId: number,
  months: number,
  referenceIso: string = new Date().toISOString()
): Promise<MonthlyStatisticsItem[]> {
  const attempts = await fetchAttemptsForUser(db, userId);

  const appliedBuckets = new Map<string, number>();
  const resultBuckets = new Map<string, { won: number; lost: number }>();

  for (const attempt of attempts) {
    const startMonth = toJstYearMonth(attempt.startedAt);
    appliedBuckets.set(startMonth, (appliedBuckets.get(startMonth) ?? 0) + 1);

    if (attempt.result && attempt.resultAt) {
      const resultMonth = toJstYearMonth(attempt.resultAt);
      const bucket = resultBuckets.get(resultMonth) ?? { won: 0, lost: 0 };
      if (attempt.result === "won") bucket.won += 1;
      else bucket.lost += 1;
      resultBuckets.set(resultMonth, bucket);
    }
  }

  return lastNMonthsJst(months, referenceIso).map((month) => {
    const applied = appliedBuckets.get(month) ?? 0;
    const { won, lost } = resultBuckets.get(month) ?? { won: 0, lost: 0 };
    const decided = won + lost;
    return { month, appliedCount: applied, wonCount: won, lostCount: lost, winRate: decided > 0 ? won / decided : null };
  });
}

export interface StoreStatisticsItem {
  storeName: string;
  appliedCount: number;
  wonCount: number;
  lostCount: number;
  /** 結果がまだ確定していない試行数。 */
  pendingResultCount: number;
  winRate: number;
}

const NO_STORE_LABEL = "店舗情報なし";

/** 店舗別の当選率ランキング。結果（当選/落選）が1件も無い店舗はランキング対象外にする。 */
export async function getStatisticsStores(db: DbOrTx, userId: number, limit: number): Promise<StoreStatisticsItem[]> {
  const [attempts, lotteryStoreRows] = await Promise.all([
    fetchAttemptsForUser(db, userId),
    db
      .select({ userLotteryId: userLotteries.id, storeName: lotteries.normalizedStoreName })
      .from(userLotteries)
      .innerJoin(lotteries, eq(lotteries.id, userLotteries.lotteryId))
      .where(and(eq(userLotteries.userId, userId), isNull(userLotteries.deletedAt))),
  ]);

  const storeNameByUserLotteryId = new Map(lotteryStoreRows.map((r) => [r.userLotteryId, r.storeName ?? NO_STORE_LABEL]));

  const buckets = new Map<string, { applied: number; won: number; lost: number; pending: number }>();
  for (const attempt of attempts) {
    const storeName = storeNameByUserLotteryId.get(attempt.lotteryId);
    if (storeName === undefined) continue; // 削除済み等で対象外になったuserLotteryId

    const bucket = buckets.get(storeName) ?? { applied: 0, won: 0, lost: 0, pending: 0 };
    bucket.applied += 1;
    if (attempt.result === "won") bucket.won += 1;
    else if (attempt.result === "lost") bucket.lost += 1;
    else bucket.pending += 1;
    buckets.set(storeName, bucket);
  }

  return [...buckets.entries()]
    .filter(([, b]) => b.won + b.lost > 0)
    .map(([storeName, b]) => ({
      storeName,
      appliedCount: b.applied,
      wonCount: b.won,
      lostCount: b.lost,
      pendingResultCount: b.pending,
      winRate: b.won / (b.won + b.lost),
    }))
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, limit);
}
