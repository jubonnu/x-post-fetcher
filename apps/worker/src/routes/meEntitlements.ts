import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { requireAuth } from "../auth/middleware.ts";
import { ApiError, apiErrorJson } from "../auth/errors.ts";
import { checkRateLimit } from "../auth/rateLimit.ts";
import { findSubscriptionEntitlement, upsertSubscriptionEntitlement } from "../repositories/subscriptionEntitlementRepository.ts";
import { fetchRevenueCatEntitlement } from "../services/revenuecatClient.ts";
import { PREMIUM_ENTITLEMENT_ID, deriveProductType } from "../services/revenuecatWebhookProcessor.ts";

/** この経過時間を超えると`GET /me/entitlements`のレスポンスで`stale: true`を返す（Nice to have）。 */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const REFRESH_RATE_LIMIT = { limit: 5, windowMs: 60_000 };

/**
 * Mobile-G4: `GET /me/entitlements`・`POST /me/entitlements/refresh`。
 * `subscription_entitlements`が唯一の正。RevenueCatの生レスポンスはモバイルへ返さない。
 */
export function registerMeEntitlements(app: Hono<AppEnv>): void {
  app.get("/me/entitlements", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;

    const existing = await findSubscriptionEntitlement(db, userId);
    if (!existing) {
      return c.json({ premiumActive: false, productType: null, expiresAt: null, lastVerifiedAt: null, stale: true });
    }

    const stale = Date.now() - Date.parse(existing.updatedAt) > STALE_AFTER_MS;
    return c.json({
      premiumActive: existing.premiumActive,
      productType: existing.productType,
      expiresAt: existing.expiresAt,
      lastVerifiedAt: existing.updatedAt,
      stale,
    });
  });

  app.post("/me/entitlements/refresh", requireAuth, async (c) => {
    const env = c.get("env");
    if (!env.REVENUECAT_SECRET_API_KEY) {
      return apiErrorJson(c, new ApiError("BILLING_NOT_CONFIGURED", "RevenueCat連携が未設定です"));
    }

    const db = c.get("db");
    const userId = c.get("userId")!;
    const publicUserId = c.get("publicUserId")!;

    // リクエスト本文は読まない — 認証済みユーザー自身のpublicUserIdのみを使う
    // （任意のApp User IDを受け取らない、22章要件）。
    if (!checkRateLimit(`entitlements-refresh:${publicUserId}`, REFRESH_RATE_LIMIT.limit, REFRESH_RATE_LIMIT.windowMs)) {
      return apiErrorJson(c, new ApiError("RATE_LIMITED", "リクエストが多すぎます。しばらくしてから再試行してください"));
    }

    const result = await fetchRevenueCatEntitlement(env.REVENUECAT_SECRET_API_KEY, publicUserId);

    if (result.type === "timeout" || result.type === "network_error") {
      return apiErrorJson(c, new ApiError("SERVICE_BUSY", "RevenueCatへの照会がタイムアウトしました。しばらくしてから再試行してください"));
    }
    if (result.type === "rate_limited") {
      return apiErrorJson(c, new ApiError("RATE_LIMITED", "RevenueCatへの照会が混雑しています。しばらくしてから再試行してください"));
    }
    if (result.type === "unauthorized" || result.type === "server_error") {
      return apiErrorJson(c, new ApiError("SERVICE_BUSY", "RevenueCatへの照会に失敗しました。しばらくしてから再試行してください"));
    }

    // REST APIレスポンスに含まれないフィールド（environment/originalTransactionId/ownershipType等）は
    // 既存値を保持する（無条件nullで上書きし、Webhookが記録済みの情報を消さないため）。
    const existing = await findSubscriptionEntitlement(db, userId);
    const productId = result.entitlement?.product_identifier ?? existing?.productId ?? null;
    const row = await upsertSubscriptionEntitlement(db, userId, {
      entitlementId: PREMIUM_ENTITLEMENT_ID,
      premiumActive: result.premiumActive,
      productId,
      productType: deriveProductType(productId, {
        monthlyProductId: env.REVENUECAT_MONTHLY_PRODUCT_ID,
        lifetimeProductId: env.REVENUECAT_LIFETIME_PRODUCT_ID,
      }),
      environment: existing?.environment ?? null,
      store: result.entitlement?.store ?? existing?.store ?? null,
      originalTransactionId: existing?.originalTransactionId ?? null,
      purchasedAt: result.entitlement?.purchase_date ?? existing?.purchasedAt ?? null,
      expiresAt: result.entitlement ? (result.entitlement.expires_date ?? null) : null,
      ownershipType: existing?.ownershipType ?? null,
      lastRevenueCatEventAt: existing?.lastRevenueCatEventAt ?? null,
      source: "refresh",
    });

    return c.json({
      premiumActive: row.premiumActive,
      productType: row.productType,
      expiresAt: row.expiresAt,
      lastVerifiedAt: row.updatedAt,
      stale: false,
    });
  });
}
