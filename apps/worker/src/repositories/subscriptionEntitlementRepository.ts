import { eq } from "drizzle-orm";
import type { DbOrTx } from "../db/client.ts";
import { subscriptionEntitlements, type SubscriptionEntitlementRow } from "../db/schema.ts";
import { isUniqueConstraintViolation } from "./userRepository.ts";

export async function findSubscriptionEntitlement(db: DbOrTx, userId: number): Promise<SubscriptionEntitlementRow | null> {
  const rows = await db.select().from(subscriptionEntitlements).where(eq(subscriptionEntitlements.userId, userId));
  return rows[0] ?? null;
}

export interface UpsertSubscriptionEntitlementFields {
  entitlementId: string;
  premiumActive: boolean;
  productId?: string | null;
  productType?: string | null;
  environment?: string | null;
  store?: string | null;
  originalTransactionId?: string | null;
  purchasedAt?: string | null;
  expiresAt?: string | null;
  ownershipType?: string | null;
  lastRevenueCatEventAt?: string | null;
  /** この状態を最後に更新した経路。'webhook' | 'refresh'。 */
  source: string;
}

/**
 * `subscription_entitlements`はpremium判定の正であり、1ユーザー1行へ常に最新化する
 * （Mobile-G4）。CASのような楽観ロックは持たない — Webhookイベントの前後関係は
 * `revenuecat_events`側の冪等性・`event_timestamp_ms`で担保し、本テーブルは常に
 * 「直近に確認できた状態」を保持するだけの単純な最新化とする。
 */
export async function upsertSubscriptionEntitlement(
  db: DbOrTx,
  userId: number,
  fields: UpsertSubscriptionEntitlementFields
): Promise<SubscriptionEntitlementRow> {
  const existing = await findSubscriptionEntitlement(db, userId);
  const now = new Date().toISOString();

  if (!existing) {
    try {
      const [row] = await db
        .insert(subscriptionEntitlements)
        .values({ userId, ...fields })
        .returning();
      return row;
    } catch (e) {
      if (!isUniqueConstraintViolation(e)) throw e;
      // 同時に初回作成が競合: 先着行への通常UPDATEにフォールバックする。
      const winner = await findSubscriptionEntitlement(db, userId);
      if (!winner) throw e;
      const [updated] = await db
        .update(subscriptionEntitlements)
        .set({ ...fields, updatedAt: now })
        .where(eq(subscriptionEntitlements.id, winner.id))
        .returning();
      return updated;
    }
  }

  const [updated] = await db
    .update(subscriptionEntitlements)
    .set({ ...fields, updatedAt: now })
    .where(eq(subscriptionEntitlements.id, existing.id))
    .returning();
  return updated;
}
