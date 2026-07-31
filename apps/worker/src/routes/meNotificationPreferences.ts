import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { requireAuth } from "../auth/middleware.ts";
import { ApiError, apiErrorJson } from "../auth/errors.ts";
import {
  NotificationPreferencesVersionConflictError,
  VIRTUAL_DEFAULT_NOTIFICATION_PREFERENCES,
  findNotificationPreferences,
  upsertNotificationPreferences,
  type NotificationPreferencesFields,
} from "../repositories/notificationPreferencesRepository.ts";
import { putNotificationPreferencesSchema } from "../validation/syncSchemas.ts";
import type { NotificationPreferencesRow } from "../db/schema.ts";
import { IdempotencyConflictError, runIdempotent } from "../services/idempotencyLedger.ts";

function toFieldsResponse(fields: NotificationPreferencesFields) {
  return fields;
}

function rowToFields(row: NotificationPreferencesRow): NotificationPreferencesFields {
  return {
    deadlineReminder: row.deadlineReminder,
    announcementReminder: row.announcementReminder,
    purchaseReminder: row.purchaseReminder,
    newLotteryAlert: row.newLotteryAlert,
    favoriteUpdateAlert: row.favoriteUpdateAlert,
    pushEnabled: row.pushEnabled,
    emailEnabled: row.emailEnabled,
    quietHoursEnabled: row.quietHoursEnabled,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
    deadlineReminderHoursBefore: row.deadlineReminderHoursBefore,
    announcementReminderHoursBefore: row.announcementReminderHoursBefore,
    purchaseReminderHoursBefore: row.purchaseReminderHoursBefore,
  };
}

async function parseJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/**
 * Mobile-G2B-5: /me/notification-preferences。
 * 初回GETは行を作成せず仮想デフォルト（serverVersion=0）を返す（不要なDB書き込みを避ける）。
 */
export function registerMeNotificationPreferences(app: Hono<AppEnv>): void {
  app.get("/me/notification-preferences", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;

    const existing = await findNotificationPreferences(db, userId);
    if (!existing) {
      return c.json({ ...toFieldsResponse(VIRTUAL_DEFAULT_NOTIFICATION_PREFERENCES), serverVersion: 0 });
    }
    return c.json({ ...toFieldsResponse(rowToFields(existing)), serverVersion: existing.serverVersion });
  });

  app.put("/me/notification-preferences", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;

    const body = await parseJsonBody(c);
    const parsed = putNotificationPreferencesSchema.safeParse(body);
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));

    const { expectedServerVersion, clientRequestId, ...fields } = parsed.data;

    try {
      const response = await runIdempotent(
        db,
        { userId, scope: "notification_preferences", clientRequestId, requestPayload: { op: "put", fields, expectedServerVersion: expectedServerVersion ?? null } },
        async (tx) => {
          const { row, outcome } = await upsertNotificationPreferences(tx, {
            userId,
            fields: fields as NotificationPreferencesFields,
            expectedServerVersion,
          });
          return { ...toFieldsResponse(rowToFields(row)), serverVersion: row.serverVersion, outcome };
        }
      );
      return c.json(response);
    } catch (e) {
      if (e instanceof IdempotencyConflictError) return apiErrorJson(c, new ApiError("IDEMPOTENCY_CONFLICT", e.message));
      if (e instanceof NotificationPreferencesVersionConflictError) {
        return c.json(
          {
            error: { code: "VERSION_CONFLICT", message: e.message, requestId: c.get("requestId") },
            current: { ...toFieldsResponse(rowToFields(e.current)), serverVersion: e.current.serverVersion },
          },
          409
        );
      }
      throw e;
    }
  });
}
