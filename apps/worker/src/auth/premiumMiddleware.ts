import type { Context, Next } from "hono";
import type { AppEnv } from "../env.ts";
import { ApiError, apiErrorJson } from "./errors.ts";
import { findSubscriptionEntitlement } from "../repositories/subscriptionEntitlementRepository.ts";

/**
 * premium必須APIの保護ミドルウェア（Mobile-G4）。`requireAuth`より後に配置する前提
 * （`c.get("userId")`が既にセットされている）。判定は必ず`subscription_entitlements`
 * テーブルのみを見る——クライアントのCustomerInfo・リクエスト本文のpremiumフラグ・
 * RevenueCat entitlementの自己申告はいずれも信頼しない。
 *
 * 設計判断（26章「課金基盤未設定時」の報告事項）: 課金基盤（Webhook/Secret API Key）が
 * 未設定でも、本ミドルウェア自体は503 BILLING_NOT_CONFIGUREDにしない。
 * `subscription_entitlements`に行が無い、またはpremiumActive=falseは「premium未加入」
 * として403 PREMIUM_REQUIREDを返すのが自然な状態だからである。BILLING_NOT_CONFIGURED
 * はWebhook/refreshエンドポイント自身（実際に外部設定を必要とする側）が返す。
 */
export async function requirePremium(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const db = c.get("db");
  const userId = c.get("userId")!;

  const entitlement = await findSubscriptionEntitlement(db, userId);
  if (!entitlement?.premiumActive) {
    return apiErrorJson(c, new ApiError("PREMIUM_REQUIRED", "この機能にはプレミアムプランが必要です"));
  }

  await next();
}
