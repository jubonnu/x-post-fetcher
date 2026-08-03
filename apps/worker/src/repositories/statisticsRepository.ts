import { and, eq, isNull } from "drizzle-orm";
import type { DbOrTx } from "../db/client.ts";
import { lotteries, userLotteries, userLotteryStatusHistory } from "../db/schema.ts";

/**
 * 統計API（Mobile-G6、premium必須）の集計ロジック。
 *
 * `deletedAt`の扱い: `GET /me/lotteries`一覧と一貫させるため、`deletedAt IS NULL`（現在保存中の
 * 抽選のみ）を対象にする。削除済みデータを当選率へ含めるかは意見が分かれる論点
 * （docs/mobile-g1-...10.3節）だが、今回は「自分の抽選一覧の実績」として一貫性を優先する
 * シンプルな方針を採用する。
 *
 * `skipped`ステータスの扱い: 遷移ホワイトリスト上`planned→skipped`（応募自体の見送り）と
 * `won→skipped`（当選後の購入見送り）の2経路があり、現在のステータス値だけでは区別できない
 * （履歴の`fromStatus`を都度確認すれば区別できるが、今回のMVPスコープでは行わない）。
 * そのため`skippedCount`は独立した集計値として返すのみとし、当選数・当選率の計算には
 * 含めない（`purchased`は`won`経由でしか到達できないため`wonCount`に安全に合算できる）。
 */

export interface StatisticsSummary {
  savedCount: number;
  plannedCount: number;
  appliedCount: number;
  notAppliedCount: number;
  wonCount: number;
  lostCount: number;
  purchasedCount: number;
  skippedCount: number;
  /** wonCount / (wonCount + lostCount)。分母0（結果が出た件が無い）ならnull（「計算不可」）。 */
  winRate: number | null;
}

export async function getStatisticsSummary(db: DbOrTx, userId: number): Promise<StatisticsSummary> {
  const rows = await db
    .select({ status: userLotteries.status })
    .from(userLotteries)
    .where(and(eq(userLotteries.userId, userId), isNull(userLotteries.deletedAt)));

  const countOf = (status: string) => rows.filter((r) => r.status === status).length;
  const wonCount = countOf("won") + countOf("purchased");
  const lostCount = countOf("lost");
  const decided = wonCount + lostCount;

  return {
    savedCount: rows.length,
    plannedCount: countOf("planned"),
    appliedCount: countOf("applied") + countOf("won") + countOf("lost") + countOf("purchased") + countOf("skipped"),
    notAppliedCount: countOf("unknown") + countOf("planned"),
    wonCount,
    lostCount,
    purchasedCount: countOf("purchased"),
    skippedCount: countOf("skipped"),
    winRate: decided > 0 ? wonCount / decided : null,
  };
}

export interface MonthlyStatisticsItem {
  /** JST基準の年月（例: "2026-08"）。 */
  month: string;
  appliedCount: number;
  wonCount: number;
  lostCount: number;
  winRate: number | null;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toJstYearMonth(iso: string): string {
  const jst = new Date(new Date(iso).getTime() + JST_OFFSET_MS);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** `referenceIso`が属するJSTの月を起点に、遡って`months`件分の年月文字列を古い順で返す。 */
function lastNMonthsJst(months: number, referenceIso: string): string[] {
  const jstRef = new Date(new Date(referenceIso).getTime() + JST_OFFSET_MS);
  const result: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(jstRef.getUTCFullYear(), jstRef.getUTCMonth() - i, 1));
    result.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return result;
}

export async function getStatisticsMonthly(
  db: DbOrTx,
  userId: number,
  months: number,
  referenceIso: string = new Date().toISOString()
): Promise<MonthlyStatisticsItem[]> {
  const rows = await db
    .select({ toStatus: userLotteryStatusHistory.toStatus, changedAt: userLotteryStatusHistory.changedAt })
    .from(userLotteryStatusHistory)
    .innerJoin(userLotteries, eq(userLotteries.id, userLotteryStatusHistory.userLotteryId))
    .where(eq(userLotteries.userId, userId));

  const buckets = new Map<string, { applied: number; won: number; lost: number }>();
  for (const row of rows) {
    const month = toJstYearMonth(row.changedAt);
    const bucket = buckets.get(month) ?? { applied: 0, won: 0, lost: 0 };
    if (row.toStatus === "applied") bucket.applied += 1;
    if (row.toStatus === "won") bucket.won += 1;
    if (row.toStatus === "lost") bucket.lost += 1;
    buckets.set(month, bucket);
  }

  return lastNMonthsJst(months, referenceIso).map((month) => {
    const b = buckets.get(month) ?? { applied: 0, won: 0, lost: 0 };
    const decided = b.won + b.lost;
    return { month, appliedCount: b.applied, wonCount: b.won, lostCount: b.lost, winRate: decided > 0 ? b.won / decided : null };
  });
}

export interface StoreStatisticsItem {
  storeName: string;
  appliedCount: number;
  wonCount: number;
  lostCount: number;
  winRate: number;
}

const NO_STORE_LABEL = "店舗情報なし";
const DECIDED_STATUSES = new Set(["applied", "won", "lost", "purchased", "skipped"]);

/** 店舗別の当選率ランキング。結果（当選/落選）が1件も無い店舗はランキング対象外にする。 */
export async function getStatisticsStores(db: DbOrTx, userId: number, limit: number): Promise<StoreStatisticsItem[]> {
  const rows = await db
    .select({ storeName: lotteries.normalizedStoreName, status: userLotteries.status })
    .from(userLotteries)
    .innerJoin(lotteries, eq(lotteries.id, userLotteries.lotteryId))
    .where(and(eq(userLotteries.userId, userId), isNull(userLotteries.deletedAt)));

  const buckets = new Map<string, { applied: number; won: number; lost: number }>();
  for (const row of rows) {
    const key = row.storeName ?? NO_STORE_LABEL;
    const bucket = buckets.get(key) ?? { applied: 0, won: 0, lost: 0 };
    if (DECIDED_STATUSES.has(row.status)) bucket.applied += 1;
    if (row.status === "won" || row.status === "purchased") bucket.won += 1;
    if (row.status === "lost") bucket.lost += 1;
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .filter(([, b]) => b.won + b.lost > 0)
    .map(([storeName, b]) => ({
      storeName,
      appliedCount: b.applied,
      wonCount: b.won,
      lostCount: b.lost,
      winRate: b.won / (b.won + b.lost),
    }))
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, limit);
}
