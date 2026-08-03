/**
 * Mobile-G6: /me/statistics系（統計・分析、premium必須）の結合テスト。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { lotteries } from "../src/db/schema.ts";
import { upsertSubscriptionEntitlement } from "../src/repositories/subscriptionEntitlementRepository.ts";
import { __setAppleJwksResolverForTests } from "../src/auth/apple.ts";
import { __resetRateLimitForTests } from "../src/auth/rateLimit.ts";
import { TEST_APPLE_CLIENT_ID, createAppleTestKeyPair, makeAppleJwksResolver, signTestAppleToken } from "./helpers/appleTestKit.ts";
import type { KeyLike } from "jose";

const DB_FILE = resolve(process.cwd(), `.tmp-me-statistics-${Date.now()}.db`);

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.APPLE_CLIENT_ID = TEST_APPLE_CLIENT_ID;
process.env.JWT_SIGNING_KEY_CURRENT_KID = "v1";
process.env.JWT_SIGNING_KEY_CURRENT_SECRET = "test-current-secret-not-for-production";
process.env.ENVIRONMENT = "test";
process.env.ACCOUNT_DELETION_GRACE_DAYS = "14";

let app: ReturnType<typeof createApp>;
let privateKey: KeyLike;
const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  app = createApp(createDb);
  const pair = await createAppleTestKeyPair();
  privateKey = pair.privateKey;
  __setAppleJwksResolverForTests(makeAppleJwksResolver(pair.publicKey));
});

afterAll(() => {
  __setAppleJwksResolverForTests(undefined);
  rmSync(DB_FILE);
});

async function loginAs(sub: string, deviceId: string): Promise<{ accessToken: string; publicUserId: string }> {
  __resetRateLimitForTests();
  const identityToken = await signTestAppleToken({ privateKey, sub });
  const res = await app.request("/auth/apple", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identityToken, deviceId }),
  });
  const body = await res.json();
  return { accessToken: body.accessToken, publicUserId: body.user.publicUserId };
}

async function makePremium(publicUserId: string): Promise<void> {
  const { users } = await import("../src/db/schema.ts");
  const { eq } = await import("drizzle-orm");
  const [user] = await db.select().from(users).where(eq(users.publicUserId, publicUserId));
  await upsertSubscriptionEntitlement(db, user.id, {
    entitlementId: "premium",
    premiumActive: true,
    productId: "cardhub_premium_monthly",
    productType: "monthly",
    environment: "SANDBOX",
    store: "APP_STORE",
    originalTransactionId: `txn-${user.id}`,
    purchasedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
    ownershipType: "PURCHASED",
    lastRevenueCatEventAt: new Date().toISOString(),
    source: "webhook",
  });
}

async function insertLottery(overrides: Partial<typeof lotteries.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(lotteries)
    .values({ productNameRaw: "テスト商品", normalizedProductName: "テスト商品", verificationStatus: "extracted", ...overrides })
    .returning();
  return row.id;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function putStatus(token: string, lotteryId: number, status: string, expectedServerVersion?: number) {
  const res = await app.request(`/me/lotteries/${lotteryId}`, {
    method: expectedServerVersion === undefined ? "PUT" : "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify(
      expectedServerVersion === undefined
        ? { status, clientRequestId: crypto.randomUUID() }
        : { status, expectedServerVersion, clientRequestId: crypto.randomUUID() }
    ),
  });
  return (await res.json()) as { serverVersion: number };
}

describe("GET /me/statistics/*（premium保護）", () => {
  it("premium未加入は403 PREMIUM_REQUIRED（summary/monthly/stores共通）", async () => {
    const { accessToken } = await loginAs("sub-stats-free", "device-1");

    for (const path of ["/me/statistics/summary", "/me/statistics/monthly", "/me/statistics/stores"]) {
      const res = await app.request(path, { headers: authHeaders(accessToken) });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("PREMIUM_REQUIRED");
    }
  });

  it("未認証は401", async () => {
    const res = await app.request("/me/statistics/summary");
    expect(res.status).toBe(401);
  });
});

describe("GET /me/statistics/summary", () => {
  it("ステータス別件数と当選率を正しく集計する", async () => {
    const { accessToken, publicUserId } = await loginAs("sub-stats-summary", "device-1");
    await makePremium(publicUserId);

    const lotteryIds = await Promise.all(Array.from({ length: 6 }, () => insertLottery()));
    // [0]planned [1]applied [2]won [3]lost [4]purchased(won経由) [5]skipped
    await putStatus(accessToken, lotteryIds[0], "planned");
    await putStatus(accessToken, lotteryIds[1], "applied");

    const v2 = (await putStatus(accessToken, lotteryIds[2], "applied")).serverVersion;
    await putStatus(accessToken, lotteryIds[2], "won", v2);

    const v3 = (await putStatus(accessToken, lotteryIds[3], "applied")).serverVersion;
    await putStatus(accessToken, lotteryIds[3], "lost", v3);

    const v4a = (await putStatus(accessToken, lotteryIds[4], "applied")).serverVersion;
    const v4b = (await putStatus(accessToken, lotteryIds[4], "won", v4a)).serverVersion;
    await putStatus(accessToken, lotteryIds[4], "purchased", v4b);

    await putStatus(accessToken, lotteryIds[5], "skipped");

    const res = await app.request("/me/statistics/summary", { headers: authHeaders(accessToken) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.savedCount).toBe(6);
    expect(body.plannedCount).toBe(1);
    expect(body.wonCount).toBe(2); // won(1件) + purchased(1件、won経由)
    expect(body.lostCount).toBe(1);
    expect(body.purchasedCount).toBe(1);
    expect(body.skippedCount).toBe(1);
    expect(body.winRate).toBeCloseTo(2 / 3);
  });

  it("結果が1件も出ていない場合、当選率はnull（計算不可）", async () => {
    const { accessToken, publicUserId } = await loginAs("sub-stats-nowinrate", "device-1");
    await makePremium(publicUserId);
    const lotteryId = await insertLottery();
    await putStatus(accessToken, lotteryId, "planned");

    const res = await app.request("/me/statistics/summary", { headers: authHeaders(accessToken) });
    const body = await res.json();
    expect(body.winRate).toBeNull();
  });
});

describe("GET /me/statistics/monthly", () => {
  it("monthsパラメータの件数分、月次配列を返す（データが無い月は0埋め）", async () => {
    const { accessToken, publicUserId } = await loginAs("sub-stats-monthly", "device-1");
    await makePremium(publicUserId);

    const res = await app.request("/me/statistics/monthly?months=3", { headers: authHeaders(accessToken) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(3);
    for (const item of body.items) {
      expect(item).toMatchObject({ appliedCount: 0, wonCount: 0, lostCount: 0, winRate: null });
    }
  });
});

describe("GET /me/statistics/stores", () => {
  it("結果が出ている店舗のみ、当選率降順でランキングする", async () => {
    const { accessToken, publicUserId } = await loginAs("sub-stats-stores", "device-1");
    await makePremium(publicUserId);

    const storeAId = await insertLottery({ normalizedStoreName: "店舗A" });
    const storeBId1 = await insertLottery({ normalizedStoreName: "店舗B" });
    const storeBId2 = await insertLottery({ normalizedStoreName: "店舗B" });
    const storeNoResultId = await insertLottery({ normalizedStoreName: "店舗C" });

    const v1 = (await putStatus(accessToken, storeAId, "applied")).serverVersion;
    await putStatus(accessToken, storeAId, "won", v1); // 店舗A: 1/1 = 100%

    const v2 = (await putStatus(accessToken, storeBId1, "applied")).serverVersion;
    await putStatus(accessToken, storeBId1, "won", v2);
    const v3 = (await putStatus(accessToken, storeBId2, "applied")).serverVersion;
    await putStatus(accessToken, storeBId2, "lost", v3); // 店舗B: 1/2 = 50%

    await putStatus(accessToken, storeNoResultId, "planned"); // 結果未確定、対象外

    const res = await app.request("/me/statistics/stores", { headers: authHeaders(accessToken) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ storeName: "店舗A", winRate: 1 });
    expect(body.items[1]).toMatchObject({ storeName: "店舗B", winRate: 0.5 });
  });
});
