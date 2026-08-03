/**
 * Mobile-G4: POST /webhooks/revenuecat の結合テスト（Hardening改訂）。
 *
 * Hardening後は、Webhookイベントを受けた際にRevenueCat REST APIで現在のsubscriber状態を
 * 取得し、それを正としてsubscription_entitlementsへ反映する（イベント種別からの直接的な
 * grant/revoke判定は廃止）。そのため`global.fetch`をモックし、`api.revenuecat.com`宛の
 * リクエストにはテストごとに設定した仮想subscriber状態を返す。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { revenuecatEvents, subscriptionEntitlements } from "../src/db/schema.ts";
import { __setAppleJwksResolverForTests } from "../src/auth/apple.ts";
import { __resetRateLimitForTests } from "../src/auth/rateLimit.ts";
import { TEST_APPLE_CLIENT_ID, createAppleTestKeyPair, makeAppleJwksResolver, signTestAppleToken } from "./helpers/appleTestKit.ts";
import type { KeyLike } from "jose";

const DB_FILE = resolve(process.cwd(), `.tmp-billing-webhook-${Date.now()}.db`);

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.APPLE_CLIENT_ID = TEST_APPLE_CLIENT_ID;
process.env.JWT_SIGNING_KEY_CURRENT_KID = "v1";
process.env.JWT_SIGNING_KEY_CURRENT_SECRET = "test-current-secret-not-for-production";
process.env.ENVIRONMENT = "test";
process.env.ACCOUNT_DELETION_GRACE_DAYS = "14";
process.env.REVENUECAT_WEBHOOK_AUTH_HEADER = "test-webhook-shared-secret";
process.env.REVENUECAT_SECRET_API_KEY = "test-secret-api-key";
delete process.env.REVENUECAT_WEBHOOK_HMAC_SECRET;
delete process.env.REVENUECAT_MONTHLY_PRODUCT_ID;
delete process.env.REVENUECAT_LIFETIME_PRODUCT_ID;

let app: ReturnType<typeof createApp>;
let privateKey: KeyLike;
const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });

// --- RevenueCat REST APIのモック ---------------------------------------------------------
interface SubscriberMock {
  status?: number;
  premiumEntitlement?: { expires_date?: string | null; product_identifier?: string; store?: string; purchase_date?: string } | null;
}

const subscriberMocks = new Map<string, SubscriberMock>();
const originalFetch = globalThis.fetch;

function mockSubscriber(appUserId: string, mock: SubscriberMock): void {
  subscriberMocks.set(appUserId, mock);
}

function clearSubscriberMocks(): void {
  subscriberMocks.clear();
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  app = createApp(createDb);
  const pair = await createAppleTestKeyPair();
  privateKey = pair.privateKey;
  __setAppleJwksResolverForTests(makeAppleJwksResolver(pair.publicKey));

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith("https://api.revenuecat.com/v1/subscribers/")) {
      return originalFetch(input, init);
    }
    const appUserId = decodeURIComponent(url.slice("https://api.revenuecat.com/v1/subscribers/".length));
    const mock = subscriberMocks.get(appUserId);
    if (!mock) {
      // モック未設定=該当ユーザーの購入情報が無いsubscriberとして扱う。
      return new Response(JSON.stringify({ subscriber: { entitlements: {} } }), { status: 200 });
    }
    if (mock.status && mock.status !== 200) {
      return new Response("", { status: mock.status });
    }
    const entitlements = mock.premiumEntitlement ? { premium: mock.premiumEntitlement } : {};
    return new Response(JSON.stringify({ subscriber: { entitlements } }), { status: 200 });
  }) as typeof fetch;
});

beforeEach(() => {
  clearSubscriberMocks();
});

afterEach(() => {
  __resetRateLimitForTests();
  delete process.env.REVENUECAT_WEBHOOK_HMAC_SECRET;
  delete process.env.REVENUECAT_MONTHLY_PRODUCT_ID;
  delete process.env.REVENUECAT_LIFETIME_PRODUCT_ID;
  if (!process.env.REVENUECAT_SECRET_API_KEY) process.env.REVENUECAT_SECRET_API_KEY = "test-secret-api-key";
});

afterAll(() => {
  __setAppleJwksResolverForTests(undefined);
  globalThis.fetch = originalFetch;
  rmSync(DB_FILE);
});

async function loginAs(sub: string, deviceId: string): Promise<string> {
  const identityToken = await signTestAppleToken({ privateKey, sub });
  const res = await app.request("/auth/apple", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identityToken, deviceId }),
  });
  const body = (await res.json()) as { user: { publicUserId: string } };
  return body.user.publicUserId;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function officialSignatureHeader(secret: string, rawBody: string, timestampSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const v1 = await hmacSha256Hex(secret, `${timestampSeconds}.${rawBody}`);
  return `t=${timestampSeconds},v1=${v1}`;
}

interface WebhookEventOverrides {
  id?: string;
  type?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  aliases?: string[];
  entitlement_ids?: string[];
  environment?: string;
  event_timestamp_ms?: number;
  product_id?: string;
  store?: string;
  purchased_at_ms?: number;
  expiration_at_ms?: number | null;
  original_transaction_id?: string;
  ownership_type?: string;
  transferred_from?: string[];
  transferred_to?: string[];
}

function buildEvent(overrides: WebhookEventOverrides) {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    type: overrides.type ?? "INITIAL_PURCHASE",
    app_user_id: overrides.app_user_id ?? "unknown-user",
    original_app_user_id: overrides.original_app_user_id,
    aliases: overrides.aliases,
    entitlement_ids: overrides.entitlement_ids ?? ["premium"],
    environment: overrides.environment ?? "SANDBOX",
    event_timestamp_ms: overrides.event_timestamp_ms ?? Date.now(),
    product_id: overrides.product_id ?? "cardhub_premium_monthly",
    store: overrides.store ?? "APP_STORE",
    purchased_at_ms: overrides.purchased_at_ms ?? Date.now(),
    expiration_at_ms: overrides.expiration_at_ms === undefined ? Date.now() + 1000 * 60 * 60 * 24 * 30 : overrides.expiration_at_ms,
    original_transaction_id: overrides.original_transaction_id ?? "txn-1",
    ownership_type: overrides.ownership_type ?? "PURCHASED",
    ...(overrides.transferred_from !== undefined ? { transferred_from: overrides.transferred_from } : {}),
    ...(overrides.transferred_to !== undefined ? { transferred_to: overrides.transferred_to } : {}),
  };
}

async function postWebhookRaw(rawBody: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request("/webhooks/revenuecat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: process.env.REVENUECAT_WEBHOOK_AUTH_HEADER!, ...headers },
    body: rawBody,
  });
}

async function postWebhook(event: ReturnType<typeof buildEvent>, headers: Record<string, string> = {}): Promise<Response> {
  return postWebhookRaw(JSON.stringify({ api_version: "1.0", event }), headers);
}

async function getSubscriptionEntitlement(userId: number) {
  const rows = await db.select().from(subscriptionEntitlements).where(eq(subscriptionEntitlements.userId, userId));
  return rows[0] ?? null;
}

async function findUserId(publicUserId: string): Promise<number> {
  const { users } = await import("../src/db/schema.ts");
  const rows = await db.select().from(users).where(eq(users.publicUserId, publicUserId));
  return rows[0]!.id;
}

const ACTIVE_MONTHLY = { product_identifier: "cardhub_premium_monthly", store: "APP_STORE", expires_date: new Date(Date.now() + 86_400_000).toISOString() };

describe("POST /webhooks/revenuecat", () => {
  describe("認証", () => {
    it("Authorizationヘッダ不正は401", async () => {
      const res = await postWebhook(buildEvent({}), { Authorization: "wrong-secret" });
      expect(res.status).toBe(401);
    });

    it("Authorizationヘッダ無しは401", async () => {
      const res = await app.request("/webhooks/revenuecat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_version: "1.0", event: buildEvent({}) }),
      });
      expect(res.status).toBe(401);
    });

    it("REVENUECAT_WEBHOOK_AUTH_HEADER未設定は503 BILLING_NOT_CONFIGURED", async () => {
      const saved = process.env.REVENUECAT_WEBHOOK_AUTH_HEADER;
      delete process.env.REVENUECAT_WEBHOOK_AUTH_HEADER;
      const res = await app.request("/webhooks/revenuecat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "anything" },
        body: JSON.stringify({ api_version: "1.0", event: buildEvent({}) }),
      });
      process.env.REVENUECAT_WEBHOOK_AUTH_HEADER = saved;
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("BILLING_NOT_CONFIGURED");
    });
  });

  describe("HMAC（公式形式限定）", () => {
    afterEach(() => {
      delete process.env.REVENUECAT_WEBHOOK_HMAC_SECRET;
    });

    it("公式形式（t=,v1=）の正しい署名は受理される", async () => {
      process.env.REVENUECAT_WEBHOOK_HMAC_SECRET = "hmac-secret";
      const publicUserId = await loginAs("hmac-ok-user", "device-hmac-1");
      mockSubscriber(publicUserId, { premiumEntitlement: ACTIVE_MONTHLY });
      const rawBody = JSON.stringify({ api_version: "1.0", event: buildEvent({ app_user_id: publicUserId, id: crypto.randomUUID() }) });
      const signature = await officialSignatureHeader("hmac-secret", rawBody);
      const res = await postWebhookRaw(rawBody, { "X-RevenueCat-Webhook-Signature": signature });
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("processed");
    });

    it("署名ヘッダ無しは401", async () => {
      process.env.REVENUECAT_WEBHOOK_HMAC_SECRET = "hmac-secret";
      const rawBody = JSON.stringify({ api_version: "1.0", event: buildEvent({}) });
      const res = await postWebhookRaw(rawBody);
      expect(res.status).toBe(401);
    });

    it("tが欠落したヘッダは401", async () => {
      process.env.REVENUECAT_WEBHOOK_HMAC_SECRET = "hmac-secret";
      const rawBody = JSON.stringify({ api_version: "1.0", event: buildEvent({}) });
      const res = await postWebhookRaw(rawBody, { "X-RevenueCat-Webhook-Signature": "v1=deadbeef" });
      expect(res.status).toBe(401);
    });

    it("v1が欠落したヘッダは401", async () => {
      process.env.REVENUECAT_WEBHOOK_HMAC_SECRET = "hmac-secret";
      const rawBody = JSON.stringify({ api_version: "1.0", event: buildEvent({}) });
      const res = await postWebhookRaw(rawBody, { "X-RevenueCat-Webhook-Signature": `t=${Math.floor(Date.now() / 1000)}` });
      expect(res.status).toBe(401);
    });

    it("不正なhex（16進以外の文字）は例外を出さず401", async () => {
      process.env.REVENUECAT_WEBHOOK_HMAC_SECRET = "hmac-secret";
      const rawBody = JSON.stringify({ api_version: "1.0", event: buildEvent({}) });
      const t = Math.floor(Date.now() / 1000);
      const res = await postWebhookRaw(rawBody, { "X-RevenueCat-Webhook-Signature": `t=${t},v1=not-a-valid-hex-signature!!` });
      expect(res.status).toBe(401);
    });

    it("hexの長さが違う場合も例外を出さず401", async () => {
      process.env.REVENUECAT_WEBHOOK_HMAC_SECRET = "hmac-secret";
      const rawBody = JSON.stringify({ api_version: "1.0", event: buildEvent({}) });
      const t = Math.floor(Date.now() / 1000);
      const res = await postWebhookRaw(rawBody, { "X-RevenueCat-Webhook-Signature": `t=${t},v1=deadbeef` });
      expect(res.status).toBe(401);
    });

    it("timestamp期限切れ（5分超過）は401", async () => {
      process.env.REVENUECAT_WEBHOOK_HMAC_SECRET = "hmac-secret";
      const rawBody = JSON.stringify({ api_version: "1.0", event: buildEvent({}) });
      const oldTimestamp = Math.floor(Date.now() / 1000) - 60 * 60; // 1時間前
      const signature = await officialSignatureHeader("hmac-secret", rawBody, oldTimestamp);
      const res = await postWebhookRaw(rawBody, { "X-RevenueCat-Webhook-Signature": signature });
      expect(res.status).toBe(401);
    });

    it("独自の「raw bodyのみへの署名」は受理されない（廃止済み方式）", async () => {
      process.env.REVENUECAT_WEBHOOK_HMAC_SECRET = "hmac-secret";
      const rawBody = JSON.stringify({ api_version: "1.0", event: buildEvent({}) });
      const legacySignature = await hmacSha256Hex("hmac-secret", rawBody); // raw bodyのみに対する署名（旧方式）
      const res = await postWebhookRaw(rawBody, { "X-RevenueCat-Webhook-Signature": legacySignature });
      expect(res.status).toBe(401);
    });

    it("HMAC設定時はAuthorizationとHMACの両方が必須（Authorization不正なら署名が正しくても401）", async () => {
      process.env.REVENUECAT_WEBHOOK_HMAC_SECRET = "hmac-secret";
      const rawBody = JSON.stringify({ api_version: "1.0", event: buildEvent({}) });
      const signature = await officialSignatureHeader("hmac-secret", rawBody);
      const res = await postWebhookRaw(rawBody, { Authorization: "wrong-secret", "X-RevenueCat-Webhook-Signature": signature });
      expect(res.status).toBe(401);
    });
  });

  describe("REST照合ベースのentitlement反映", () => {
    it("premium付与（INITIAL_PURCHASE）でREST照合結果がsubscription_entitlementsへ反映される", async () => {
      const publicUserId = await loginAs("grant-user", "device-grant-1");
      const userId = await findUserId(publicUserId);
      mockSubscriber(publicUserId, { premiumEntitlement: ACTIVE_MONTHLY });

      const res = await postWebhook(buildEvent({ app_user_id: publicUserId, type: "INITIAL_PURCHASE" }));
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("processed");

      const entitlement = await getSubscriptionEntitlement(userId);
      expect(entitlement?.premiumActive).toBe(true);
      expect(entitlement?.productId).toBe("cardhub_premium_monthly");
    });

    it("RENEWALでもREST照合結果がactiveなら有効のまま更新される", async () => {
      const publicUserId = await loginAs("renewal-user", "device-renewal-1");
      const userId = await findUserId(publicUserId);
      mockSubscriber(publicUserId, { premiumEntitlement: ACTIVE_MONTHLY });
      await postWebhook(buildEvent({ app_user_id: publicUserId, type: "INITIAL_PURCHASE", id: crypto.randomUUID() }));

      const res = await postWebhook(buildEvent({ app_user_id: publicUserId, type: "RENEWAL", id: crypto.randomUUID() }));
      expect(res.status).toBe(200);

      const entitlement = await getSubscriptionEntitlement(userId);
      expect(entitlement?.premiumActive).toBe(true);
    });

    it("CANCELLATIONでもREST照合を行い、RESTがまだactiveならpremiumActiveはtrueのまま", async () => {
      const publicUserId = await loginAs("cancel-user", "device-cancel-1");
      const userId = await findUserId(publicUserId);
      mockSubscriber(publicUserId, { premiumEntitlement: ACTIVE_MONTHLY }); // 自動更新OFFでも期限までは有効
      await postWebhook(buildEvent({ app_user_id: publicUserId, type: "INITIAL_PURCHASE", id: crypto.randomUUID() }));

      const res = await postWebhook(buildEvent({ app_user_id: publicUserId, type: "CANCELLATION", id: crypto.randomUUID() }));
      expect(res.status).toBe(200);

      const entitlement = await getSubscriptionEntitlement(userId);
      expect(entitlement?.premiumActive).toBe(true);
    });

    it("EXPIRATIONでRESTがinactiveを返せばpremiumActive=falseになる", async () => {
      const publicUserId = await loginAs("expiration-user", "device-expiration-1");
      const userId = await findUserId(publicUserId);
      mockSubscriber(publicUserId, { premiumEntitlement: ACTIVE_MONTHLY });
      await postWebhook(buildEvent({ app_user_id: publicUserId, type: "INITIAL_PURCHASE", id: crypto.randomUUID() }));

      mockSubscriber(publicUserId, { premiumEntitlement: null }); // 期限切れ後のREST状態
      const res = await postWebhook(
        buildEvent({ app_user_id: publicUserId, type: "EXPIRATION", id: crypto.randomUUID(), event_timestamp_ms: Date.now() + 1 })
      );
      expect(res.status).toBe(200);

      const entitlement = await getSubscriptionEntitlement(userId);
      expect(entitlement?.premiumActive).toBe(false);
    });

    it("REFUNDでRESTがinactiveを返せばpremiumActive=falseになる", async () => {
      const publicUserId = await loginAs("refund-user", "device-refund-1");
      const userId = await findUserId(publicUserId);
      mockSubscriber(publicUserId, { premiumEntitlement: ACTIVE_MONTHLY });
      await postWebhook(buildEvent({ app_user_id: publicUserId, type: "INITIAL_PURCHASE", id: crypto.randomUUID() }));

      mockSubscriber(publicUserId, { premiumEntitlement: null });
      const res = await postWebhook(
        buildEvent({ app_user_id: publicUserId, type: "REFUND", id: crypto.randomUUID(), event_timestamp_ms: Date.now() + 1 })
      );
      expect(res.status).toBe(200);

      const entitlement = await getSubscriptionEntitlement(userId);
      expect(entitlement?.premiumActive).toBe(false);
    });

    it("REVENUECAT_SECRET_API_KEY未設定時はfailed_retryableでpremium状態を変更しない", async () => {
      const saved = process.env.REVENUECAT_SECRET_API_KEY;
      delete process.env.REVENUECAT_SECRET_API_KEY;
      const publicUserId = await loginAs("no-secret-key-user", "device-no-secret-1");
      const userId = await findUserId(publicUserId);

      const res = await postWebhook(buildEvent({ app_user_id: publicUserId, type: "INITIAL_PURCHASE" }));
      process.env.REVENUECAT_SECRET_API_KEY = saved;
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("failed_retryable");

      const entitlement = await getSubscriptionEntitlement(userId);
      expect(entitlement).toBeNull(); // premium状態は作られていない
    });

    it("RevenueCat REST APIが一時的に失敗（500）した場合はfailed_retryableでpremium状態を変更しない", async () => {
      const publicUserId = await loginAs("rest-failure-user", "device-rest-failure-1");
      const userId = await findUserId(publicUserId);
      mockSubscriber(publicUserId, { status: 500 });

      const res = await postWebhook(buildEvent({ app_user_id: publicUserId, type: "INITIAL_PURCHASE" }));
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("failed_retryable");

      const entitlement = await getSubscriptionEntitlement(userId);
      expect(entitlement).toBeNull();
    });

    it("productTypeは設定済みProduct IDとの一致でのみ判定する（未設定なら'unknown'）", async () => {
      const publicUserId = await loginAs("product-type-user", "device-product-type-1");
      const userId = await findUserId(publicUserId);
      mockSubscriber(publicUserId, { premiumEntitlement: ACTIVE_MONTHLY });

      await postWebhook(buildEvent({ app_user_id: publicUserId, type: "INITIAL_PURCHASE" }));
      const before = await getSubscriptionEntitlement(userId);
      expect(before?.productType).toBe("unknown");

      process.env.REVENUECAT_MONTHLY_PRODUCT_ID = "cardhub_premium_monthly";
      await postWebhook(buildEvent({ app_user_id: publicUserId, type: "RENEWAL", id: crypto.randomUUID(), event_timestamp_ms: Date.now() + 1 }));
      const after = await getSubscriptionEntitlement(userId);
      expect(after?.productType).toBe("subscription");
    });
  });

  describe("イベント順序逆転対策", () => {
    it("RENEWALとEXPIRATIONの到着順が逆転しても、最終的にeventTimestampの新しい方が勝つ", async () => {
      const publicUserId = await loginAs("order-reversal-user", "device-order-1");
      const userId = await findUserId(publicUserId);
      const now = Date.now();

      // EXPIRATION（新しいeventTimestamp、RESTはinactive）が先に到着。
      mockSubscriber(publicUserId, { premiumEntitlement: null });
      await postWebhook(buildEvent({ app_user_id: publicUserId, type: "EXPIRATION", event_timestamp_ms: now + 1000 }));
      expect((await getSubscriptionEntitlement(userId))?.premiumActive).toBe(false);

      // その後、より古いeventTimestampのRENEWAL（RESTはactive）が遅延到着。
      mockSubscriber(publicUserId, { premiumEntitlement: ACTIVE_MONTHLY });
      const res = await postWebhook(buildEvent({ app_user_id: publicUserId, type: "RENEWAL", event_timestamp_ms: now }));
      expect((await res.json()).status).toBe("superseded");

      // 新しい方（EXPIRATION=inactive）の状態が保たれる。
      expect((await getSubscriptionEntitlement(userId))?.premiumActive).toBe(false);
    });

    it("CANCELLATION処理後、より古いINITIAL_PURCHASEが遅れて到着してもsupersededとして状態を上書きしない", async () => {
      const publicUserId = await loginAs("stale-purchase-user", "device-stale-1");
      const userId = await findUserId(publicUserId);
      const now = Date.now();

      mockSubscriber(publicUserId, { premiumEntitlement: ACTIVE_MONTHLY });
      await postWebhook(buildEvent({ app_user_id: publicUserId, type: "CANCELLATION", event_timestamp_ms: now + 1000 }));
      expect((await getSubscriptionEntitlement(userId))?.premiumActive).toBe(true);

      // 古いタイムスタンプの遅延INITIAL_PURCHASE。
      const res = await postWebhook(buildEvent({ app_user_id: publicUserId, type: "INITIAL_PURCHASE", event_timestamp_ms: now }));
      expect((await res.json()).status).toBe("superseded");
    });
  });

  describe("TRANSFER（専用スキーマ・専用処理）", () => {
    it("transferred_from（旧）・transferred_to（新）両方のREST状態を反映する", async () => {
      const fromUserPublicId = await loginAs("transfer-from-user", "device-transfer-from-1");
      const toUserPublicId = await loginAs("transfer-to-user", "device-transfer-to-1");
      const fromUserId = await findUserId(fromUserPublicId);
      const toUserId = await findUserId(toUserPublicId);

      mockSubscriber(fromUserPublicId, { premiumEntitlement: null }); // 移譲後、旧ユーザーはpremiumを失う
      mockSubscriber(toUserPublicId, { premiumEntitlement: ACTIVE_MONTHLY }); // 移譲後、新ユーザーがpremiumを得る

      const res = await postWebhook(
        buildEvent({ type: "TRANSFER", app_user_id: toUserPublicId, transferred_from: [fromUserPublicId], transferred_to: [toUserPublicId] })
      );
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("processed");

      expect((await getSubscriptionEntitlement(fromUserId))?.premiumActive).toBe(false);
      expect((await getSubscriptionEntitlement(toUserId))?.premiumActive).toBe(true);

      // 再試行に必要な最小コンテキスト（transferred_from/to）が保存されていること（課金公開前Blocker対応）。
      const [eventRow] = await db
        .select()
        .from(revenuecatEvents)
        .where(eq(revenuecatEvents.appUserId, toUserPublicId));
      expect(JSON.parse(eventRow.transferredFromJson!)).toEqual([fromUserPublicId]);
      expect(JSON.parse(eventRow.transferredToJson!)).toEqual([toUserPublicId]);
    });

    it("transferred_fromが複数件でもそれぞれ照合する", async () => {
      const fromA = await loginAs("transfer-from-a", "device-transfer-from-a-1");
      const fromB = await loginAs("transfer-from-b", "device-transfer-from-b-1");
      const toUser = await loginAs("transfer-to-multi", "device-transfer-to-multi-1");
      mockSubscriber(fromA, { premiumEntitlement: null });
      mockSubscriber(fromB, { premiumEntitlement: null });
      mockSubscriber(toUser, { premiumEntitlement: ACTIVE_MONTHLY });

      const res = await postWebhook(buildEvent({ type: "TRANSFER", app_user_id: toUser, transferred_from: [fromA, fromB], transferred_to: [toUser] }));
      expect((await res.json()).status).toBe("processed");

      expect((await getSubscriptionEntitlement(await findUserId(fromA)))?.premiumActive).toBe(false);
      expect((await getSubscriptionEntitlement(await findUserId(fromB)))?.premiumActive).toBe(false);
      expect((await getSubscriptionEntitlement(await findUserId(toUser)))?.premiumActive).toBe(true);
    });

    it("transferred_toが複数件でもそれぞれ照合する", async () => {
      const fromUser = await loginAs("transfer-from-single", "device-transfer-from-single-1");
      const toA = await loginAs("transfer-to-a", "device-transfer-to-a-1");
      const toB = await loginAs("transfer-to-b", "device-transfer-to-b-1");
      mockSubscriber(fromUser, { premiumEntitlement: null });
      mockSubscriber(toA, { premiumEntitlement: ACTIVE_MONTHLY });
      mockSubscriber(toB, { premiumEntitlement: ACTIVE_MONTHLY });

      const res = await postWebhook(buildEvent({ type: "TRANSFER", app_user_id: toA, transferred_from: [fromUser], transferred_to: [toA, toB] }));
      expect((await res.json()).status).toBe("processed");

      expect((await getSubscriptionEntitlement(await findUserId(toA)))?.premiumActive).toBe(true);
      expect((await getSubscriptionEntitlement(await findUserId(toB)))?.premiumActive).toBe(true);
    });

    it("一方が未知ユーザーでも既知の側は処理する", async () => {
      const toUser = await loginAs("transfer-known-side", "device-transfer-known-1");
      mockSubscriber(toUser, { premiumEntitlement: ACTIVE_MONTHLY });

      const res = await postWebhook(
        buildEvent({
          type: "TRANSFER",
          app_user_id: toUser,
          transferred_from: ["99999999-9999-9999-9999-999999999999"],
          transferred_to: [toUser],
        })
      );
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("processed");
      expect((await getSubscriptionEntitlement(await findUserId(toUser)))?.premiumActive).toBe(true);
    });

    it("REST API一時失敗はfailed_retryableとして記録される", async () => {
      const fromUser = await loginAs("transfer-rest-fail-from", "device-transfer-rest-fail-from-1");
      const toUser = await loginAs("transfer-rest-fail-to", "device-transfer-rest-fail-to-1");
      mockSubscriber(fromUser, { status: 500 });
      mockSubscriber(toUser, { premiumEntitlement: ACTIVE_MONTHLY });

      const res = await postWebhook(buildEvent({ type: "TRANSFER", app_user_id: toUser, transferred_from: [fromUser], transferred_to: [toUser] }));
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("failed_retryable");
    });

    it("同じTransfer eventの再送はduplicateとして扱われる", async () => {
      const fromUser = await loginAs("transfer-dup-from", "device-transfer-dup-from-1");
      const toUser = await loginAs("transfer-dup-to", "device-transfer-dup-to-1");
      mockSubscriber(fromUser, { premiumEntitlement: null });
      mockSubscriber(toUser, { premiumEntitlement: ACTIVE_MONTHLY });
      const event = buildEvent({ type: "TRANSFER", app_user_id: toUser, transferred_from: [fromUser], transferred_to: [toUser] });

      const first = await postWebhook(event);
      expect((await first.json()).status).toBe("processed");

      const second = await postWebhook(event);
      expect((await second.json()).status).toBe("duplicate");
    });

    it("transferred_from/transferred_toが欠落した不正なTRANSFERペイロードはignored_invalid_payload", async () => {
      const toUser = await loginAs("transfer-invalid-payload", "device-transfer-invalid-1");
      const res = await postWebhookRaw(
        JSON.stringify({ api_version: "1.0", event: { ...buildEvent({ type: "TRANSFER", app_user_id: toUser }), transferred_from: undefined, transferred_to: undefined } })
      );
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("ignored_invalid_payload");
    });
  });

  describe("冪等性・監査", () => {
    it("event.idの再送（同一payload）はduplicateとして200・二重処理しない", async () => {
      const publicUserId = await loginAs("dup-user", "device-dup-1");
      mockSubscriber(publicUserId, { premiumEntitlement: ACTIVE_MONTHLY });
      const event = buildEvent({ app_user_id: publicUserId, type: "INITIAL_PURCHASE" });

      const first = await postWebhook(event);
      expect((await first.json()).status).toBe("processed");

      const second = await postWebhook(event);
      expect(second.status).toBe(200);
      expect((await second.json()).status).toBe("duplicate");

      const events = await db.select().from(revenuecatEvents).where(eq(revenuecatEvents.revenueCatEventId, event.id));
      expect(events).toHaveLength(1); // 二重にレコードが増えない
    });

    it("同じevent.idで異なるpayloadは200・conflictとして記録される（要調査扱い）", async () => {
      const publicUserId = await loginAs("conflict-user", "device-conflict-1");
      mockSubscriber(publicUserId, { premiumEntitlement: ACTIVE_MONTHLY });
      const eventId = crypto.randomUUID();
      const first = buildEvent({ app_user_id: publicUserId, type: "INITIAL_PURCHASE", id: eventId });
      await postWebhook(first);

      const second = buildEvent({ app_user_id: publicUserId, type: "RENEWAL", id: eventId }); // 同じid、違う内容
      const res = await postWebhook(second);
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("conflict");

      const [row] = await db.select().from(revenuecatEvents).where(eq(revenuecatEvents.revenueCatEventId, eventId));
      expect(row.processingStatus).toBe("error");
      expect(row.errorCode).toBe("payload_hash_mismatch");
    });

    it("optionalフィールド欠落でも処理できる（最小限のイベント）", async () => {
      const publicUserId = await loginAs("minimal-user", "device-minimal-1");
      mockSubscriber(publicUserId, { premiumEntitlement: ACTIVE_MONTHLY });
      const res = await postWebhook({
        id: crypto.randomUUID(),
        type: "INITIAL_PURCHASE",
        app_user_id: publicUserId,
        entitlement_ids: ["premium"],
      } as ReturnType<typeof buildEvent>);
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("processed");
    });

    it("premiumを含まないentitlement_idsは無視される（premium状態を変更しない）", async () => {
      const publicUserId = await loginAs("other-entitlement-user", "device-other-1");
      const userId = await findUserId(publicUserId);

      const res = await postWebhook(buildEvent({ app_user_id: publicUserId, entitlement_ids: ["some_other_entitlement"] }));
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("ignored_not_premium");

      const entitlement = await getSubscriptionEntitlement(userId);
      expect(entitlement).toBeNull();
    });

    it("未知のApp User IDは200・ignored_unknown_userで記録され、勝手にユーザーを作らない", async () => {
      const res = await postWebhook(buildEvent({ app_user_id: "99999999-9999-9999-9999-999999999999" }));
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("ignored_unknown_user");
    });

    it("未対応のイベント種別は200・ignored_unknown_eventでpremium状態を変更しない", async () => {
      const publicUserId = await loginAs("unknown-event-user", "device-unknown-1");
      const userId = await findUserId(publicUserId);
      mockSubscriber(publicUserId, { premiumEntitlement: ACTIVE_MONTHLY });
      await postWebhook(buildEvent({ app_user_id: publicUserId, type: "INITIAL_PURCHASE", id: crypto.randomUUID() }));

      const res = await postWebhook(buildEvent({ app_user_id: publicUserId, type: "SOME_FUTURE_EVENT_TYPE", id: crypto.randomUUID() }));
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("ignored_unknown_event");

      const entitlement = await getSubscriptionEntitlement(userId);
      expect(entitlement?.premiumActive).toBe(true); // 変更されていない
    });

    it("app_user_idが不一致でもoriginal_app_user_idで解決できる", async () => {
      const publicUserId = await loginAs("alias-original-user", "device-alias-original-1");
      const userId = await findUserId(publicUserId);
      mockSubscriber(publicUserId, { premiumEntitlement: ACTIVE_MONTHLY });

      const res = await postWebhook(
        buildEvent({ app_user_id: "$RCAnonymousID:abc123", original_app_user_id: publicUserId, type: "INITIAL_PURCHASE" })
      );
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("processed");

      const entitlement = await getSubscriptionEntitlement(userId);
      expect(entitlement?.premiumActive).toBe(true);
    });

    it("app_user_id・original_app_user_idが不一致でもaliasesで解決できる", async () => {
      const publicUserId = await loginAs("alias-list-user", "device-alias-list-1");
      const userId = await findUserId(publicUserId);
      mockSubscriber(publicUserId, { premiumEntitlement: ACTIVE_MONTHLY });

      const res = await postWebhook(
        buildEvent({
          app_user_id: "$RCAnonymousID:xyz789",
          original_app_user_id: "$RCAnonymousID:xyz789",
          aliases: ["$RCAnonymousID:xyz789", publicUserId],
          type: "INITIAL_PURCHASE",
        })
      );
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("processed");

      const entitlement = await getSubscriptionEntitlement(userId);
      expect(entitlement?.premiumActive).toBe(true);
    });
  });

  it("既存の公開API（GET /lotteries）はWebhook追加後も影響を受けない", async () => {
    const res = await app.request("/lotteries");
    expect(res.status).toBe(200);
  });
});
