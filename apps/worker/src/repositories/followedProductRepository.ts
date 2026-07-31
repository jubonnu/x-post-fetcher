import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { DbOrTx } from "../db/client.ts";
import { followedProducts, products, type FollowedProductRow, type ProductRow } from "../db/schema.ts";
import { isUniqueConstraintViolation } from "./userRepository.ts";

export async function findFollow(db: DbOrTx, userId: number, productId: number): Promise<FollowedProductRow | null> {
  const rows = await db
    .select()
    .from(followedProducts)
    .where(and(eq(followedProducts.userId, userId), eq(followedProducts.productId, productId), isNull(followedProducts.deletedAt)));
  return rows[0] ?? null;
}

export async function findFollowIncludingDeleted(db: DbOrTx, userId: number, productId: number): Promise<FollowedProductRow | null> {
  const rows = await db
    .select()
    .from(followedProducts)
    .where(and(eq(followedProducts.userId, userId), eq(followedProducts.productId, productId)));
  return rows[0] ?? null;
}

export interface FollowedProductWithProduct {
  follow: FollowedProductRow;
  product: ProductRow;
}

export async function listFollowedProducts(
  db: DbOrTx,
  userId: number,
  opts: { limit?: number; offset?: number } = {}
): Promise<{ items: FollowedProductWithProduct[]; total: number }> {
  const { limit = 20, offset = 0 } = opts;
  const where = and(eq(followedProducts.userId, userId), isNull(followedProducts.deletedAt));

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ follow: followedProducts, product: products })
      .from(followedProducts)
      .innerJoin(products, eq(products.id, followedProducts.productId))
      .where(where)
      .orderBy(desc(followedProducts.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(followedProducts).where(where),
  ]);

  return { items: rows, total };
}

/** フォロー中のproductId集合を返す（一括同期のスキップ判定用）。 */
export async function findFollowedProductIds(db: DbOrTx, userId: number, productIds: number[]): Promise<Set<number>> {
  if (productIds.length === 0) return new Set();
  const rows = await db
    .select({ productId: followedProducts.productId })
    .from(followedProducts)
    .where(and(eq(followedProducts.userId, userId), inArray(followedProducts.productId, productIds), isNull(followedProducts.deletedAt)));
  return new Set(rows.map((r) => r.productId));
}

export type FollowOutcome = "created" | "restored" | "noop";

/**
 * フォロー追加（Mobile-G2B-3、G2B-Hardeningで冪等性判定を台帳へ分離した純粋な操作）。
 * 復元は必ず既存行の`deletedAt`を戻す形で行い、新規行を作らない（行IDを維持する）。
 */
export async function addFollow(db: DbOrTx, params: { userId: number; productId: number }): Promise<{ row: FollowedProductRow; outcome: FollowOutcome }> {
  const existing = await findFollowIncludingDeleted(db, params.userId, params.productId);
  const now = new Date().toISOString();

  if (!existing) {
    try {
      const [row] = await db.insert(followedProducts).values({ userId: params.userId, productId: params.productId }).returning();
      return { row, outcome: "created" };
    } catch (e) {
      if (!isUniqueConstraintViolation(e)) throw e;
      const winner = await findFollowIncludingDeleted(db, params.userId, params.productId);
      if (!winner) throw e;
      return { row: winner, outcome: "noop" };
    }
  }

  if (!existing.deletedAt) {
    return { row: existing, outcome: "noop" };
  }

  const [restored] = await db
    .update(followedProducts)
    .set({ deletedAt: null, updatedAt: now })
    .where(eq(followedProducts.id, existing.id))
    .returning();
  return { row: restored, outcome: "restored" };
}

/** 論理削除。冪等。純粋な操作（冪等性判定は呼び出し側の台帳が行う）。 */
export async function removeFollow(db: DbOrTx, params: { userId: number; productId: number }): Promise<{ found: boolean }> {
  const existing = await findFollowIncludingDeleted(db, params.userId, params.productId);
  if (!existing) return { found: false };
  if (existing.deletedAt) return { found: true };

  const now = new Date().toISOString();
  await db.update(followedProducts).set({ deletedAt: now, updatedAt: now }).where(eq(followedProducts.id, existing.id));
  return { found: true };
}
