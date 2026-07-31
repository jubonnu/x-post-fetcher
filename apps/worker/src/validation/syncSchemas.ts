import { z } from "zod";
import { LOTTERY_STATUSES } from "../services/lotteryStatusTransitions.ts";
import { lotterySnapshotSchema } from "./lotterySnapshot.ts";
import {
  CHECKLIST_LABEL_MAX_LENGTH,
  CHECKLIST_MAX_ITEMS_PER_PUT,
  CHECKLIST_NOTE_MAX_LENGTH,
  QUIET_HOURS_TIME_REGEX,
  REMINDER_HOURS_BEFORE_MAX,
  REMINDER_HOURS_BEFORE_MIN,
  SYNC_MAX_ITEMS_PER_ARRAY,
  UUID_REGEX,
  isParsableDate,
} from "./limits.ts";

export const clientRequestIdSchema = z.string().regex(UUID_REGEX, "clientRequestIdはUUID形式である必要があります");
export const deviceIdSchema = z.string().regex(UUID_REGEX, "deviceIdはUUID形式である必要があります");
const isoDateSchema = z.string().refine(isParsableDate, "日時形式が不正です");
const lotteryStatusSchema = z.enum(LOTTERY_STATUSES);

// ---- user_lotteries ----

export const putUserLotterySchema = z.object({
  status: lotteryStatusSchema.optional(),
  snapshot: lotterySnapshotSchema.optional(),
  savedAt: isoDateSchema.optional(),
  expectedServerVersion: z.number().int().min(0).optional(),
  clientRequestId: clientRequestIdSchema,
});

export const patchUserLotteryStatusSchema = z.object({
  status: lotteryStatusSchema,
  expectedServerVersion: z.number().int().min(0),
  clientRequestId: clientRequestIdSchema,
});

export const deleteUserLotterySchema = z.object({
  expectedServerVersion: z.number().int().min(0).optional(),
  clientRequestId: clientRequestIdSchema,
});

export const syncLotteriesRequestSchema = z.object({
  items: z
    .array(
      z.object({
        lotteryId: z.number().int().positive(),
        status: lotteryStatusSchema,
        savedAt: isoDateSchema.optional(),
        snapshot: lotterySnapshotSchema.optional(),
        clientRequestId: clientRequestIdSchema,
      })
    )
    .max(SYNC_MAX_ITEMS_PER_ARRAY),
  deviceId: deviceIdSchema.optional(),
});

// ---- favorites / followed products ----

export const putFavoriteSchema = z.object({
  clientRequestId: clientRequestIdSchema,
});

export const deleteFavoriteSchema = z.object({
  clientRequestId: clientRequestIdSchema,
});

export const putFollowedProductSchema = z.object({
  clientRequestId: clientRequestIdSchema,
});

export const deleteFollowedProductSchema = z.object({
  clientRequestId: clientRequestIdSchema,
});

// ---- checklist ----

const checklistStepUpsertSchema = z.object({
  stepId: z.string().min(1).max(200),
  label: z.string().min(1).max(CHECKLIST_LABEL_MAX_LENGTH),
  done: z.boolean(),
  completedNote: z.string().max(CHECKLIST_NOTE_MAX_LENGTH).nullable().optional(),
  sortOrder: z.number().int().optional(),
  clientActionAt: isoDateSchema.optional(),
  expectedServerVersion: z.number().int().min(0),
  clientRequestId: clientRequestIdSchema,
});

export const putChecklistSchema = z.object({
  steps: z.array(checklistStepUpsertSchema).min(1).max(CHECKLIST_MAX_ITEMS_PER_PUT),
});

// ---- notification preferences ----

export const putNotificationPreferencesSchema = z.object({
  deadlineReminder: z.boolean(),
  announcementReminder: z.boolean(),
  purchaseReminder: z.boolean(),
  newLotteryAlert: z.boolean(),
  favoriteUpdateAlert: z.boolean(),
  pushEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  quietHoursEnabled: z.boolean(),
  quietHoursStart: z.string().regex(QUIET_HOURS_TIME_REGEX).nullable(),
  quietHoursEnd: z.string().regex(QUIET_HOURS_TIME_REGEX).nullable(),
  deadlineReminderHoursBefore: z.number().int().min(REMINDER_HOURS_BEFORE_MIN).max(REMINDER_HOURS_BEFORE_MAX),
  announcementReminderHoursBefore: z.number().int().min(REMINDER_HOURS_BEFORE_MIN).max(REMINDER_HOURS_BEFORE_MAX),
  purchaseReminderHoursBefore: z.number().int().min(REMINDER_HOURS_BEFORE_MIN).max(REMINDER_HOURS_BEFORE_MAX),
  expectedServerVersion: z.number().int().min(0).optional(),
  clientRequestId: clientRequestIdSchema,
});

// ---- bootstrap sync ----

export const syncBootstrapRequestSchema = z.object({
  batchClientRequestId: clientRequestIdSchema,
  deviceId: deviceIdSchema.optional(),
  userLotteries: syncLotteriesRequestSchema.shape.items.optional().default([]),
  favorites: z
    .array(z.object({ lotteryId: z.number().int().positive(), clientRequestId: clientRequestIdSchema }))
    .max(SYNC_MAX_ITEMS_PER_ARRAY)
    .optional()
    .default([]),
  followedProducts: z
    .array(z.object({ publicProductId: z.string().uuid(), clientRequestId: clientRequestIdSchema }))
    .max(SYNC_MAX_ITEMS_PER_ARRAY)
    .optional()
    .default([]),
  /**
   * Mobile-G3互換処理: モバイル側の旧フォローデータ（`normalizedProductName`文字列そのもの、
   * publicProductId未解決）をサーバー側で商品マスタへ完全一致解決するための入力。
   * `product_aliases.normalizedAlias`が指す商品IDが1つに絞れる場合のみ移行する
   * （あいまい一致はしない、新規商品も作成しない）。結果は`legacyFollowedProducts`で返す。
   */
  legacyFollowedProductKeys: z.array(z.string().min(1)).max(SYNC_MAX_ITEMS_PER_ARRAY).optional().default([]),
  checklistSteps: z
    .array(
      z.object({
        lotteryId: z.number().int().positive(),
        stepId: z.string().min(1).max(200),
        label: z.string().min(1).max(CHECKLIST_LABEL_MAX_LENGTH),
        done: z.boolean(),
        completedNote: z.string().max(CHECKLIST_NOTE_MAX_LENGTH).nullable().optional(),
        sortOrder: z.number().int().optional(),
        clientRequestId: clientRequestIdSchema,
      })
    )
    .max(SYNC_MAX_ITEMS_PER_ARRAY)
    .optional()
    .default([]),
  notificationPreferences: putNotificationPreferencesSchema.omit({ expectedServerVersion: true }).optional(),
});
