import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { DbOrTx } from "../db/client.ts";
import { userFavorites, type UserFavoriteRow } from "../db/schema.ts";
import { isUniqueConstraintViolation } from "./userRepository.ts";

export async function findFavorite(db: DbOrTx, userId: number, lotteryId: number): Promise<UserFavoriteRow | null> {
  const rows = await db
    .select()
    .from(userFavorites)
    .where(and(eq(userFavorites.userId, userId), eq(userFavorites.lotteryId, lotteryId), isNull(userFavorites.deletedAt)));
  return rows[0] ?? null;
}

export async function findFavoriteIncludingDeleted(db: DbOrTx, userId: number, lotteryId: number): Promise<UserFavoriteRow | null> {
  const rows = await db.select().from(userFavorites).where(and(eq(userFavorites.userId, userId), eq(userFavorites.lotteryId, lotteryId)));
  return rows[0] ?? null;
}

export async function listFavorites(
  db: DbOrTx,
  userId: number,
  opts: { limit?: number; offset?: number } = {}
): Promise<{ items: UserFavoriteRow[]; total: number }> {
  const { limit = 20, offset = 0 } = opts;
  const where = and(eq(userFavorites.userId, userId), isNull(userFavorites.deletedAt));
  const [items, [{ total }]] = await Promise.all([
    db.select().from(userFavorites).where(where).orderBy(desc(userFavorites.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(userFavorites).where(where),
  ]);
  return { items, total };
}

export type FavoriteOutcome = "created" | "restored" | "noop";

/**
 * お気に入り追加（Mobile-G2B-3、G2B-Hardeningで冪等性判定を`idempotency_records`台帳へ分離した
 * 「純粋な」操作。呼び出し側が`runIdempotent`で台帳確認・本関数呼び出し・台帳記録を
 * 単一トランザクションにまとめる）。`serverVersion`を持たないため「追加のみのマージ」
 * （新規作成 or 論理削除からの復元）で解決する（20-1節の確定方針）。
 * 復元は必ず既存行の`deletedAt`を戻す形で行い、新規行を作らない（行IDを維持する）。
 */
export async function addFavorite(db: DbOrTx, params: { userId: number; lotteryId: number }): Promise<{ row: UserFavoriteRow; outcome: FavoriteOutcome }> {
  const existing = await findFavoriteIncludingDeleted(db, params.userId, params.lotteryId);
  const now = new Date().toISOString();

  if (!existing) {
    try {
      const [row] = await db.insert(userFavorites).values({ userId: params.userId, lotteryId: params.lotteryId }).returning();
      return { row, outcome: "created" };
    } catch (e) {
      if (!isUniqueConstraintViolation(e)) throw e;
      // 同時追加のレース: 別リクエストが先に作成済み。500にはせず、既存行を再利用する。
      const winner = await findFavoriteIncludingDeleted(db, params.userId, params.lotteryId);
      if (!winner) throw e;
      return { row: winner, outcome: "noop" };
    }
  }

  if (!existing.deletedAt) {
    // 既に有効なお気に入り。冪等に現在の状態を返す（重複追加はunique制約により構造的に不可）。
    return { row: existing, outcome: "noop" };
  }

  const [restored] = await db
    .update(userFavorites)
    .set({ deletedAt: null, updatedAt: now })
    .where(eq(userFavorites.id, existing.id))
    .returning();
  return { row: restored, outcome: "restored" };
}

/** 論理削除。冪等（既に削除済みでも成功として扱う）。純粋な操作（冪等性判定は呼び出し側の台帳が行う）。 */
export async function removeFavorite(db: DbOrTx, params: { userId: number; lotteryId: number }): Promise<{ found: boolean }> {
  const existing = await findFavoriteIncludingDeleted(db, params.userId, params.lotteryId);
  if (!existing) return { found: false };
  if (existing.deletedAt) return { found: true };

  const now = new Date().toISOString();
  await db.update(userFavorites).set({ deletedAt: now, updatedAt: now }).where(eq(userFavorites.id, existing.id));
  return { found: true };
}
