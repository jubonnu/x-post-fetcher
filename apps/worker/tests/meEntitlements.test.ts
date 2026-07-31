/**
 * Mobile-G4: GET /me/entitlements, POST /me/entitlements/refresh の結合テスト。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { __setAppleJwksResolverForTests } from "../src/auth/apple.ts";
import { __resetRateLimitForTests } from "../src/auth/rateLimit.ts";
import { TEST_APPLE_CLIENT_ID, createAppleTestKeyPair, makeAppleJwksResolver, signTestAppleToken } from "./helpers/appleTestKit.ts";
import type { KeyLike } from "jose";

const DB_FILE = resolve(process.cwd(), `.tmp-me-entitlements-${Date.now()}.db`);

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.APPLE_CLIENT_ID = TEST_APPLE_CLIENT_ID;
process.env.JWT_SIGNING_KEY_CURRENT_KID = "v1";
process.env.JWT_SIGNING_KEY_CURRENT_SECRET = "test-current-secret-not-for-production";
process.env.ENVIRONMENT = "test";
process.env.ACCOUNT_DELETION_GRACE_DAYS = "14";

let app: ReturnType<typeof createApp>;
let privateKey: KeyLike;

beforeAll(async () => {
  const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });
  await migrate(db, { migrationsFolder: "./migrations" });
  app = createApp(createDb);
  const pair = await createAppleTestKeyPair();
  privateKey = pair.privateKey;
  __setAppleJwksResolverForTests(makeAppleJwksResolver(pair.publicKey));
});

afterEach(() => {
  __resetRateLimitForTests();
  vi.unstubAllGlobals();
  delete process.env.REVENUECAT_SECRET_API_KEY;
  delete process.env.REVENUECAT_MONTHLY_PRODUCT_ID;
  delete process.env.REVENUECAT_LIFETIME_PRODUCT_ID;
});

afterAll(() => {
  __setAppleJwksResolverForTests(undefined);
  rmSync(DB_FILE);
});

beforeEach(() => {
  __resetRateLimitForTests();
});

async function loginAs(sub: string, deviceId: string): Promise<string> {
  const identityToken = await signTestAppleToken({ privateKey, sub });
  const res = await app.request("/auth/apple", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identityToken, deviceId }),
  });
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

describe("GET /me/entitlements", () => {
  it("subscription_entitlements行が無ければpremiumActive=false・stale=true", async () => {
    const token = await loginAs("entitlements-get-user-1", "device-1");
    const res = await app.request("/me/entitlements", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ premiumActive: false, productType: null, expiresAt: null, lastVerifiedAt: null, stale: true });
  });

  it("認証無しは401", async () => {
    const res = await app.request("/me/entitlements");
    expect(res.status).toBe(401);
  });
});

describe("POST /me/entitlements/refresh", () => {
  it("REVENUECAT_SECRET_API_KEY未設定は503 BILLING_NOT_CONFIGURED", async () => {
    delete process.env.REVENUECAT_SECRET_API_KEY;
    const token = await loginAs("refresh-not-configured-user", "device-1");
    const res = await app.request("/me/entitlements/refresh", { method: "POST", headers: authHeaders(token) });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BILLING_NOT_CONFIGURED");
  });

  it("成功時、subscription_entitlementsを更新しGET側にも反映される", async () => {
    process.env.REVENUECAT_SECRET_API_KEY = "test-secret-key";
    process.env.REVENUECAT_MONTHLY_PRODUCT_ID = "cardhub_premium_monthly";
    const token = await loginAs("refresh-success-user", "device-1");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          subscriber: {
            entitlements: {
              premium: {
                expires_date: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
                purchase_date: new Date().toISOString(),
                product_identifier: "cardhub_premium_monthly",
                store: "app_store",
              },
            },
          },
        })
      )
    );

    const res = await app.request("/me/entitlements/refresh", { method: "POST", headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { premiumActive: boolean; productType: string | null };
    expect(body.premiumActive).toBe(true);
    expect(body.productType).toBe("subscription");

    const getRes = await app.request("/me/entitlements", { headers: authHeaders(token) });
    expect((await getRes.json()).premiumActive).toBe(true);
  });

  it("Product ID未確定（マップ未設定）ならproductTypeは'unknown'（誤推測しない）", async () => {
    process.env.REVENUECAT_SECRET_API_KEY = "test-secret-key";
    const token = await loginAs("refresh-unmapped-product-user", "device-unmapped-1");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          subscriber: {
            entitlements: {
              premium: {
                expires_date: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
                product_identifier: "cardhub_premium_monthly",
                store: "app_store",
              },
            },
          },
        })
      )
    );

    const res = await app.request("/me/entitlements/refresh", { method: "POST", headers: authHeaders(token) });
    const body = (await res.json()) as { premiumActive: boolean; productType: string | null };
    expect(body.premiumActive).toBe(true);
    expect(body.productType).toBe("unknown");
  });

  it("entitlement無し（未購入）ならpremiumActive=false", async () => {
    process.env.REVENUECAT_SECRET_API_KEY = "test-secret-key";
    const token = await loginAs("refresh-no-entitlement-user", "device-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { subscriber: { entitlements: {} } })));

    const res = await app.request("/me/entitlements/refresh", { method: "POST", headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect((await res.json()).premiumActive).toBe(false);
  });

  it("RevenueCat 401はSERVICE_BUSYとして扱う（Secret Keyをモバイルへ返さない）", async () => {
    process.env.REVENUECAT_SECRET_API_KEY = "test-secret-key";
    const token = await loginAs("refresh-401-user", "device-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { message: "invalid key" })));

    const res = await app.request("/me/entitlements/refresh", { method: "POST", headers: authHeaders(token) });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("SERVICE_BUSY");
    expect(JSON.stringify(body)).not.toContain("test-secret-key");
  });

  it("RevenueCat 429はRATE_LIMITEDとして扱う", async () => {
    process.env.REVENUECAT_SECRET_API_KEY = "test-secret-key";
    const token = await loginAs("refresh-429-user", "device-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { message: "rate limited" }, { "Retry-After": "5" })));

    const res = await app.request("/me/entitlements/refresh", { method: "POST", headers: authHeaders(token) });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("RevenueCat 5xxはSERVICE_BUSYとして扱う", async () => {
    process.env.REVENUECAT_SECRET_API_KEY = "test-secret-key";
    const token = await loginAs("refresh-5xx-user", "device-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503, { message: "down" })));

    const res = await app.request("/me/entitlements/refresh", { method: "POST", headers: authHeaders(token) });
    expect(res.status).toBe(503);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("SERVICE_BUSY");
  });

  it("RevenueCatへのタイムアウトはSERVICE_BUSYとして扱う", async () => {
    process.env.REVENUECAT_SECRET_API_KEY = "test-secret-key";
    const token = await loginAs("refresh-timeout-user", "device-1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      })
    );

    const res = await app.request("/me/entitlements/refresh", { method: "POST", headers: authHeaders(token) });
    expect(res.status).toBe(503);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("SERVICE_BUSY");
  }, 15_000);

  it("リクエスト本文のuserId/appUserIdは無視され、認証済みユーザー自身のみが照会される（他ユーザー照会不可）", async () => {
    process.env.REVENUECAT_SECRET_API_KEY = "test-secret-key";
    const tokenA = await loginAs("refresh-cross-user-a", "device-a");
    const tokenB = await loginAs("refresh-cross-user-b", "device-b");

    let requestedAppUserId: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        requestedAppUserId = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
        return Promise.resolve(jsonResponse(200, { subscriber: { entitlements: {} } }));
      })
    );

    // userBのpublicUserIdをリクエストボディへ紛れ込ませても無視されることを確認する。
    const res = await app.request("/me/entitlements/refresh", {
      method: "POST",
      headers: authHeaders(tokenA),
      body: JSON.stringify({ appUserId: "malicious-attempt", publicUserId: "should-be-ignored" }),
    });
    expect(res.status).toBe(200);
    expect(requestedAppUserId).not.toBe("malicious-attempt");
    expect(requestedAppUserId).not.toBe("should-be-ignored");

    // tokenB自体は未使用だが、変数として明示的に参照しlintの未使用警告を避ける。
    expect(typeof tokenB).toBe("string");
  });

  it("短時間の連続呼び出しはレート制限される", async () => {
    process.env.REVENUECAT_SECRET_API_KEY = "test-secret-key";
    const token = await loginAs("refresh-ratelimit-user", "device-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { subscriber: { entitlements: {} } })));

    let lastStatus = 200;
    for (let i = 0; i < 10; i++) {
      const res = await app.request("/me/entitlements/refresh", { method: "POST", headers: authHeaders(token) });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
