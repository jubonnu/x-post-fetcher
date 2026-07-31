import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../db/client.ts";
import { notificationPreferences, type NotificationPreferencesRow } from "../db/schema.ts";
import { isUniqueConstraintViolation } from "./userRepository.ts";

export type NotificationPreferencesFields = Omit<NotificationPreferencesRow, "id" | "userId" | "serverVersion" | "createdAt" | "updatedAt">;

/**
 * サーバーに未保存（行が存在しない）場合に返す仮想デフォルト値（Mobile-G2B-5）。
 * `apps/mobile/data/mockData.ts`の`defaultNotificationSettings`と一致させる
 * （モバイル側が実際にローカルで使っている既定値と表示差異を生まないため）。
 */
export const VIRTUAL_DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferencesFields = {
  deadlineReminder: true,
  announcementReminder: true,
  purchaseReminder: true,
  newLotteryAlert: true,
  favoriteUpdateAlert: false,
  pushEnabled: true,
  emailEnabled: false,
  quietHoursEnabled: true,
  quietHoursStart: "23:00",
  quietHoursEnd: "7:00",
  deadlineReminderHoursBefore: 3,
  announcementReminderHoursBefore: 6,
  purchaseReminderHoursBefore: 6,
};

export async function findNotificationPreferences(db: DbOrTx, userId: number): Promise<NotificationPreferencesRow | null> {
  const rows = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
  return rows[0] ?? null;
}

export class NotificationPreferencesVersionConflictError extends Error {
  current: NotificationPreferencesRow;
  constructor(current: NotificationPreferencesRow) {
    super("serverVersionが一致しません（他の端末からの更新と競合しています）");
    this.name = "NotificationPreferencesVersionConflictError";
    this.current = current;
  }
}

export interface UpsertNotificationPreferencesParams {
  userId: number;
  fields: NotificationPreferencesFields;
  expectedServerVersion?: number;
}

export type UpsertNotificationPreferencesOutcome = "created" | "updated";

/**
 * 通知設定のCAS upsert（Mobile-G2B-5、G2B-Hardeningで冪等性判定を台帳へ分離した純粋な操作）。
 * 行が存在しない場合は新規作成（`expectedServerVersion`は問わない。初回GETは仮想デフォルトを
 * 返すのみでDB行を作らないため、`expectedServerVersion`はクライアントにとって意味を持たない）。
 * 行が存在する場合のみCASを要求する。
 */
export async function upsertNotificationPreferences(
  db: DbOrTx,
  params: UpsertNotificationPreferencesParams
): Promise<{ row: NotificationPreferencesRow; outcome: UpsertNotificationPreferencesOutcome }> {
  const existing = await findNotificationPreferences(db, params.userId);
  const now = new Date().toISOString();

  if (!existing) {
    try {
      const [row] = await db
        .insert(notificationPreferences)
        .values({ userId: params.userId, ...params.fields, serverVersion: 1 })
        .returning();
      return { row, outcome: "created" };
    } catch (e) {
      if (!isUniqueConstraintViolation(e)) throw e;
      // 同時に初回作成が競合: 先着が作成済み。500にはせず、通常のCAS更新へフォールバックする。
      const winner = await findNotificationPreferences(db, params.userId);
      if (!winner) throw e;
      return upsertNotificationPreferences(db, { ...params, expectedServerVersion: winner.serverVersion });
    }
  }

  const [updated] = await db
    .update(notificationPreferences)
    .set({ ...params.fields, serverVersion: existing.serverVersion + 1, updatedAt: now })
    .where(and(eq(notificationPreferences.id, existing.id), eq(notificationPreferences.serverVersion, params.expectedServerVersion ?? -1)))
    .returning();

  if (!updated) {
    const [current] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.id, existing.id));
    throw new NotificationPreferencesVersionConflictError(current);
  }

  return { row: updated, outcome: "updated" };
}
