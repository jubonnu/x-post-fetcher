import { revenueCatSubscriberResponseSchema, type RevenueCatSubscriberEntitlement } from "../validation/billingSchemas.ts";
import { PREMIUM_ENTITLEMENT_ID } from "./revenuecatWebhookProcessor.ts";

/**
 * RevenueCat REST API クライアント（Mobile-G4、購入直後の即時照合フォールバック用）。
 * Secret API Keyはこのモジュールの呼び出し元（Worker Secrets経由）でのみ扱い、
 * レスポンスをモバイルへそのまま返さない（`routes/meEntitlements.ts`が整形して返す）。
 */

const REVENUECAT_API_BASE = "https://api.revenuecat.com/v1";
const REQUEST_TIMEOUT_MS = 10_000;

export type RevenueCatApiResult =
  | { type: "success"; premiumActive: boolean; entitlement: RevenueCatSubscriberEntitlement | null }
  | { type: "unauthorized" }
  | { type: "rate_limited"; retryAfterSeconds: number | null }
  | { type: "server_error" }
  | { type: "timeout" }
  | { type: "network_error" };

function isEntitlementActive(entitlement: RevenueCatSubscriberEntitlement): boolean {
  if (!entitlement.expires_date) return true; // lifetime相当（expires_date無し）
  return new Date(entitlement.expires_date).getTime() > Date.now();
}

export async function fetchRevenueCatEntitlement(secretApiKey: string, appUserId: string): Promise<RevenueCatApiResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${REVENUECAT_API_BASE}/subscribers/${encodeURIComponent(appUserId)}`, {
      headers: { Authorization: `Bearer ${secretApiKey}` },
      signal: controller.signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") return { type: "timeout" };
    return { type: "network_error" };
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 401 || response.status === 403) return { type: "unauthorized" };
  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : null;
    return { type: "rate_limited", retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null };
  }
  if (!response.ok) return { type: "server_error" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { type: "server_error" };
  }

  const parsed = revenueCatSubscriberResponseSchema.safeParse(body);
  if (!parsed.success) return { type: "server_error" };

  const entitlement = parsed.data.subscriber.entitlements[PREMIUM_ENTITLEMENT_ID] ?? null;
  if (!entitlement) return { type: "success", premiumActive: false, entitlement: null };

  return { type: "success", premiumActive: isEntitlementActive(entitlement), entitlement };
}
