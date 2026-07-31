import { z } from "zod";

/**
 * RevenueCat Webhookペイロードの検証（Mobile-G4）。
 * RevenueCatのイベント形状はイベント種別によってフィールドの有無が変わり、将来のダッシュボード
 * 側の仕様変更で新フィールドが追加されることもあるため、`.passthrough()`で未知フィールドを
 * 拒否せず許容する。処理に実際に使うフィールドのみ型を明示し、それ以外はoptionalとして扱う
 * （22章「RevenueCatのSometimesフィールドはoptionalとして解析」）。
 */
export const revenueCatWebhookEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    app_user_id: z.string().min(1),
    original_app_user_id: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    environment: z.string().optional(),
    event_timestamp_ms: z.number().optional(),
    entitlement_ids: z.array(z.string()).optional(),
    entitlement_id: z.string().optional(),
    product_id: z.string().optional(),
    period_type: z.string().optional(),
    purchased_at_ms: z.number().optional(),
    expiration_at_ms: z.number().nullable().optional(),
    store: z.string().optional(),
    transaction_id: z.string().optional(),
    original_transaction_id: z.string().optional(),
    ownership_type: z.string().optional(),
  })
  .passthrough();

export const revenueCatWebhookPayloadSchema = z
  .object({
    api_version: z.string().optional(),
    event: revenueCatWebhookEventSchema,
  })
  .passthrough();

export type RevenueCatWebhookEvent = z.infer<typeof revenueCatWebhookEventSchema>;
export type RevenueCatWebhookPayload = z.infer<typeof revenueCatWebhookPayloadSchema>;

/**
 * TRANSFERイベント専用スキーマ（Mobile-G4 Hardening）。TRANSFERは他のイベント種別と異なり
 * `transferred_from`（複数の旧App User ID）・`transferred_to`（複数の新App User ID）を持つため、
 * 通常イベントの`app_user_id`単体解決とは別処理として扱う。どちらの配列も欠落・不正形式なら
 * 検証エラーとし、premium状態は変更しない（安全側に倒れる）。
 */
export const revenueCatTransferEventSchema = revenueCatWebhookEventSchema.extend({
  type: z.literal("TRANSFER"),
  transferred_from: z.array(z.string()),
  transferred_to: z.array(z.string()),
});

export type RevenueCatTransferEvent = z.infer<typeof revenueCatTransferEventSchema>;

/**
 * RevenueCat REST API（`GET /subscribers/{app_user_id}`）レスポンスの検証。
 * こちらもWebhook同様、実際のレスポンス全体を厳密に固定せず`.passthrough()`で受ける
 * （購入直後の即時照合フォールバック専用の最小限の読み取りに留める）。
 */
export const revenueCatSubscriberEntitlementSchema = z
  .object({
    expires_date: z.string().nullable().optional(),
    purchase_date: z.string().optional(),
    product_identifier: z.string().optional(),
    store: z.string().optional(),
    grace_period_expires_date: z.string().nullable().optional(),
  })
  .passthrough();

export const revenueCatSubscriberResponseSchema = z
  .object({
    subscriber: z
      .object({
        original_app_user_id: z.string().optional(),
        entitlements: z.record(z.string(), revenueCatSubscriberEntitlementSchema).optional().default({}),
      })
      .passthrough(),
  })
  .passthrough();

export type RevenueCatSubscriberEntitlement = z.infer<typeof revenueCatSubscriberEntitlementSchema>;
