/**
 * Mobile-G2B-3: /me/favorites, /me/followed-products の結合テスト。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { lotteries, products } from "../src/db/schema.ts";
import { __setAppleJwksResolverForTests } from "../src/auth/apple.ts";
import { __resetRateLimitForTests } from "../src/auth/rateLimit.ts";
import { TEST_APPLE_CLIENT_ID, createAppleTestKeyPair, makeAppleJwksResolver, signTestAppleToken } from "./helpers/appleTestKit.ts";
import type { KeyLike } from "jose";

const DB_FILE = resolve(process.cwd(), `.tmp-me-favorites-${Date.now()}.db`);

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

async function loginAs(sub: string, deviceId: string): Promise<{ accessToken: string }> {
  __resetRateLimitForTests();
  const identityToken = await signTestAppleToken({ privateKey, sub });
  const res = await app.request("/auth/apple", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identityToken, deviceId }),
  });
  const body = await res.json();
  return { accessToken: body.accessToken };
}

async function insertLottery(): Promise<number> {
  const [row] = await db
    .insert(lotteries)
    .values({ productNameRaw: "テスト商品", normalizedProductName: "テスト商品", verificationStatus: "extracted" })
    .returning();
  return row.id;
}

async function insertProduct(overrides: Partial<typeof products.$inferInsert> = {}): Promise<{ publicProductId: string; id: number }> {
  const [row] = await db
    .insert(products)
    .values({ publicProductId: crypto.randomUUID(), canonicalName: "商品X", normalizedName: "商品X", ...overrides })
    .returning();
  return { publicProductId: row.publicProductId, id: row.id };
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("お気に入り", () => {
  it("追加できる", async () => {
    const { accessToken } = await loginAs("sub-fav-1", "d1");
    const lotteryId = await insertLottery();
    const res = await app.request(`/me/favorites/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe("created");

    const list = await app.request("/me/favorites", { method: "GET", headers: authHeaders(accessToken) });
    const listBody = await list.json();
    expect(listBody.items.find((i: { lotteryId: number }) => i.lotteryId === lotteryId)).toBeDefined();
  });

  it("重複追加しても行が増えない（冪等）", async () => {
    const { accessToken } = await loginAs("sub-fav-2", "d1");
    const lotteryId = await insertLottery();
    await app.request(`/me/favorites/${lotteryId}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });
    const second = await app.request(`/me/favorites/${lotteryId}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });
    expect(second.status).toBe(200);

    const list = await app.request("/me/favorites", { method: "GET", headers: authHeaders(accessToken) });
    const listBody = await list.json();
    expect(listBody.items.filter((i: { lotteryId: number }) => i.lotteryId === lotteryId)).toHaveLength(1);
  });

  it("削除でき、再削除も冪等", async () => {
    const { accessToken } = await loginAs("sub-fav-3", "d1");
    const lotteryId = await insertLottery();
    await app.request(`/me/favorites/${lotteryId}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });

    const del1 = await app.request(`/me/favorites/${lotteryId}`, { method: "DELETE", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });
    expect(del1.status).toBe(200);
    const del2 = await app.request(`/me/favorites/${lotteryId}`, { method: "DELETE", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });
    expect(del2.status).toBe(200);

    const list = await app.request("/me/favorites", { method: "GET", headers: authHeaders(accessToken) });
    const listBody = await list.json();
    expect(listBody.items.find((i: { lotteryId: number }) => i.lotteryId === lotteryId)).toBeUndefined();
  });

  it("削除後に再追加すると復元される（新規行を増やさない）", async () => {
    const { accessToken } = await loginAs("sub-fav-4", "d1");
    const lotteryId = await insertLottery();
    await app.request(`/me/favorites/${lotteryId}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });
    await app.request(`/me/favorites/${lotteryId}`, { method: "DELETE", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });

    const restore = await app.request(`/me/favorites/${lotteryId}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });
    expect(restore.status).toBe(200);
    const restoreBody = await restore.json();
    expect(restoreBody.outcome).toBe("restored");
  });

  it("同時追加は両方成功しても行は1件のみ", async () => {
    const { accessToken } = await loginAs("sub-fav-5", "d1");
    const lotteryId = await insertLottery();
    const attempt = () => app.request(`/me/favorites/${lotteryId}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });
    const [a, b] = await Promise.all([attempt(), attempt()]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const list = await app.request("/me/favorites", { method: "GET", headers: authHeaders(accessToken) });
    const listBody = await list.json();
    expect(listBody.items.filter((i: { lotteryId: number }) => i.lotteryId === lotteryId)).toHaveLength(1);
  });

  it("他ユーザーのお気に入りは見えない", async () => {
    const userA = await loginAs("sub-fav-idor-a", "da");
    const userB = await loginAs("sub-fav-idor-b", "db");
    const lotteryId = await insertLottery();
    await app.request(`/me/favorites/${lotteryId}`, { method: "PUT", headers: authHeaders(userA.accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });

    const listB = await app.request("/me/favorites", { method: "GET", headers: authHeaders(userB.accessToken) });
    const listBBody = await listB.json();
    expect(listBBody.items.find((i: { lotteryId: number }) => i.lotteryId === lotteryId)).toBeUndefined();
  });
});

describe("フォロー", () => {
  it("追加できる", async () => {
    const { accessToken } = await loginAs("sub-follow-1", "d1");
    const product = await insertProduct();
    const res = await app.request(`/me/followed-products/${product.publicProductId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publicProductId).toBe(product.publicProductId);

    const list = await app.request("/me/followed-products", { method: "GET", headers: authHeaders(accessToken) });
    const listBody = await list.json();
    expect(listBody.items.find((i: { publicProductId: string }) => i.publicProductId === product.publicProductId)).toBeDefined();
  });

  it("削除でき復元できる", async () => {
    const { accessToken } = await loginAs("sub-follow-2", "d1");
    const product = await insertProduct();
    await app.request(`/me/followed-products/${product.publicProductId}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });
    const del = await app.request(`/me/followed-products/${product.publicProductId}`, { method: "DELETE", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });
    expect(del.status).toBe(200);

    const restore = await app.request(`/me/followed-products/${product.publicProductId}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });
    expect(restore.status).toBe(200);
    const restoreBody = await restore.json();
    expect(restoreBody.outcome).toBe("restored");
  });

  it("存在しないproductは404", async () => {
    const { accessToken } = await loginAs("sub-follow-404", "d1");
    const res = await app.request(`/me/followed-products/${crypto.randomUUID()}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(404);
  });

  it("mergedな商品をフォローすると統合先の商品に対してフォローされる", async () => {
    const { accessToken } = await loginAs("sub-follow-merged", "d1");
    const target = await insertProduct({ canonicalName: "統合後" });
    const source = await insertProduct({ canonicalName: "統合前" });
    await db.update(products).set({ lifecycleStatus: "merged", mergedIntoProductId: target.id }).where(eq(products.id, source.id));

    const res = await app.request(`/me/followed-products/${source.publicProductId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publicProductId).toBe(target.publicProductId);
  });

  it("archivedな商品はフォローできない", async () => {
    const { accessToken } = await loginAs("sub-follow-archived", "d1");
    const product = await insertProduct({ lifecycleStatus: "archived" });
    const res = await app.request(`/me/followed-products/${product.publicProductId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(409);
  });

  it("同時追加は両方成功しても行は1件のみ", async () => {
    const { accessToken } = await loginAs("sub-follow-race", "d1");
    const product = await insertProduct();
    const attempt = () =>
      app.request(`/me/followed-products/${product.publicProductId}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });
    const [a, b] = await Promise.all([attempt(), attempt()]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const list = await app.request("/me/followed-products", { method: "GET", headers: authHeaders(accessToken) });
    const listBody = await list.json();
    expect(listBody.items.filter((i: { publicProductId: string }) => i.publicProductId === product.publicProductId)).toHaveLength(1);
  });

  it("他ユーザーのフォローは見えない", async () => {
    const userA = await loginAs("sub-follow-idor-a", "da");
    const userB = await loginAs("sub-follow-idor-b", "db");
    const product = await insertProduct();
    await app.request(`/me/followed-products/${product.publicProductId}`, { method: "PUT", headers: authHeaders(userA.accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });

    const listB = await app.request("/me/followed-products", { method: "GET", headers: authHeaders(userB.accessToken) });
    const listBBody = await listB.json();
    expect(listBBody.items.find((i: { publicProductId: string }) => i.publicProductId === product.publicProductId)).toBeUndefined();
  });
});
