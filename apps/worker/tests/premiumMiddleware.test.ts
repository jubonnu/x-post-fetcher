/**
 * Mobile-G4: requirePremiumミドルウェアの単体テスト。
 * 既存の無料機能・ルートには一切接続せず、テスト専用の保護ルートに直接マウントして検証する。
 */
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { users } from "../src/db/schema.ts";
import { requirePremium } from "../src/auth/premiumMiddleware.ts";
import { upsertSubscriptionEntitlement } from "../src/repositories/subscriptionEntitlementRepository.ts";
import type { AppEnv } from "../src/env.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-premium-middleware-${Date.now()}.db`);
const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });

let userId: number;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  const [user] = await db.insert(users).values({ publicUserId: "11111111-1111-1111-1111-111111111111" }).returning();
  userId = user.id;
});

afterAll(() => {
  rmSync(DB_FILE);
});

function buildTestApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    const headerUserId = c.req.header("X-Test-User-Id");
    if (headerUserId) c.set("userId", Number(headerUserId));
    await next();
  });
  app.get("/internal/test/premium-only", requirePremium, (c) => c.json({ ok: true }));
  return app;
}

describe("requirePremium", () => {
  it("premiumActive=trueなら通過する", async () => {
    await upsertSubscriptionEntitlement(db, userId, {
      entitlementId: "premium",
      premiumActive: true,
      productId: "cardhub_premium_monthly",
      productType: "monthly",
      environment: "SANDBOX",
      store: "APP_STORE",
      originalTransactionId: "txn-1",
      purchasedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
      ownershipType: "PURCHASED",
      lastRevenueCatEventAt: new Date().toISOString(),
      source: "webhook",
    });

    const app = buildTestApp();
    const res = await app.request("/internal/test/premium-only", { headers: { "X-Test-User-Id": String(userId) } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("premiumActive=falseなら403 PREMIUM_REQUIRED", async () => {
    await upsertSubscriptionEntitlement(db, userId, {
      entitlementId: "premium",
      premiumActive: false,
      lastRevenueCatEventAt: new Date().toISOString(),
      source: "webhook",
    });

    const app = buildTestApp();
    const res = await app.request("/internal/test/premium-only", { headers: { "X-Test-User-Id": String(userId) } });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PREMIUM_REQUIRED");
  });

  it("subscription_entitlements行が無いユーザーも403 PREMIUM_REQUIRED", async () => {
    const [otherUser] = await db.insert(users).values({ publicUserId: "22222222-2222-2222-2222-222222222222" }).returning();

    const app = buildTestApp();
    const res = await app.request("/internal/test/premium-only", { headers: { "X-Test-User-Id": String(otherUser.id) } });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PREMIUM_REQUIRED");
  });
});
