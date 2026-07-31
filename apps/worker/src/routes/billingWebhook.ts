import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { ApiError, apiErrorJson } from "../auth/errors.ts";
import { verifyWebhookAuthorizationHeader, verifyWebhookHmacSignature } from "../auth/webhookAuth.ts";
import { sha256Hex } from "../auth/hash.ts";
import { revenueCatWebhookPayloadSchema } from "../validation/billingSchemas.ts";
import { processRevenueCatWebhookEvent } from "../services/revenuecatWebhookProcessor.ts";

/**
 * Mobile-G4: POST /webhooks/revenuecat。既存`/lotteries`系の公開CORS設定は適用しない
 * （サーバー間通信のみ、12章）。CardHubの`requireAuth`（JWT）は使わず、RevenueCat専用の
 * 認証（共有シークレット＋任意のHMAC署名）で保護する。
 */
export function registerBillingWebhook(app: Hono<AppEnv>): void {
  app.post("/webhooks/revenuecat", async (c) => {
    const env = c.get("env");
    if (!env.REVENUECAT_WEBHOOK_AUTH_HEADER) {
      return apiErrorJson(c, new ApiError("BILLING_NOT_CONFIGURED", "RevenueCat Webhookが未設定です"));
    }

    // JSON parse前のraw bodyを保持する（HMAC検証・payloadHash算出のいずれもraw body基準）。
    const rawBody = await c.req.text();

    const authOk = verifyWebhookAuthorizationHeader(c.req.header("Authorization"), env.REVENUECAT_WEBHOOK_AUTH_HEADER);
    if (!authOk) {
      return apiErrorJson(c, new ApiError("UNAUTHORIZED", "Webhook認証に失敗しました"));
    }

    if (env.REVENUECAT_WEBHOOK_HMAC_SECRET) {
      const hmacOk = await verifyWebhookHmacSignature({
        secret: env.REVENUECAT_WEBHOOK_HMAC_SECRET,
        rawBody,
        signatureHeader: c.req.header("X-RevenueCat-Webhook-Signature"),
      });
      if (!hmacOk) {
        return apiErrorJson(c, new ApiError("UNAUTHORIZED", "Webhook署名検証に失敗しました"));
      }
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストボディが不正です"));
    }

    const parsed = revenueCatWebhookPayloadSchema.safeParse(json);
    if (!parsed.success) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));
    }

    const db = c.get("db");
    const payloadHash = await sha256Hex(rawBody);
    // 短時間・単一トランザクション相当の同期処理に限定する（キュー基盤は今回追加しない）。
    // 処理中の例外はcatchせずそのまま5xxにし、RevenueCat側の自動リトライに委ねる
    // （未知ユーザー・未対応イベント・重複・一時的なREST照合失敗等、再送不要なケースは
    // processRevenueCatWebhookEvent内で例外を投げず200相当の結果を返す設計にしている）。
    const status = await processRevenueCatWebhookEvent(db, parsed.data.event, payloadHash, {
      secretApiKey: env.REVENUECAT_SECRET_API_KEY,
      monthlyProductId: env.REVENUECAT_MONTHLY_PRODUCT_ID,
      lifetimeProductId: env.REVENUECAT_LIFETIME_PRODUCT_ID,
    });
    return c.json({ ok: true, status });
  });
}
