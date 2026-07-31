/**
 * Mobile-G2B統合: POST /me/sync/bootstrap の結合テスト。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { lotteries, productAliases, products } from "../src/db/schema.ts";
import { __setAppleJwksResolverForTests } from "../src/auth/apple.ts";
import { __resetRateLimitForTests } from "../src/auth/rateLimit.ts";
import { TEST_APPLE_CLIENT_ID, createAppleTestKeyPair, makeAppleJwksResolver, signTestAppleToken } from "./helpers/appleTestKit.ts";
import type { KeyLike } from "jose";

const DB_FILE = resolve(process.cwd(), `.tmp-me-sync-bootstrap-${Date.now()}.db`);

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

async function insertProduct(): Promise<string> {
  const [row] = await db.insert(products).values({ publicProductId: crypto.randomUUID(), canonicalName: "商品Y", normalizedName: "商品Y" }).returning();
  return row.publicProductId;
}

async function insertProductWithAlias(normalizedAlias: string, normalizerVersion = "v1"): Promise<{ productId: number; publicProductId: string }> {
  const [product] = await db
    .insert(products)
    .values({ publicProductId: crypto.randomUUID(), canonicalName: normalizedAlias, normalizedName: normalizedAlias })
    .returning();
  await db.insert(productAliases).values({
    productId: product.id,
    aliasName: normalizedAlias,
    normalizedAlias,
    normalizerVersion,
    source: "initial_migration",
  });
  return { productId: product.id, publicProductId: product.publicProductId };
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("POST /me/sync/bootstrap", () => {
  it("新規データを一括で反映しserverStateを返す", async () => {
    const { accessToken } = await loginAs("sub-boot-1", "d1");
    const lotteryId = await insertLottery();
    const publicProductId = await insertProduct();

    const res = await app.request("/me/sync/bootstrap", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        batchClientRequestId: crypto.randomUUID(),
        userLotteries: [{ lotteryId, status: "planned", clientRequestId: crypto.randomUUID() }],
        favorites: [{ lotteryId, clientRequestId: crypto.randomUUID() }],
        followedProducts: [{ publicProductId, clientRequestId: crypto.randomUUID() }],
        checklistSteps: [],
        notificationPreferences: undefined,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.syncId).toEqual(expect.any(String));
    expect(body.results.userLotteries.accepted).toBe(1);
    expect(body.results.favorites.accepted).toBe(1);
    expect(body.results.followedProducts.accepted).toBe(1);
    expect(body.serverState.userLotteries).toHaveLength(1);
    expect(body.serverState.favorites).toHaveLength(1);
    expect(body.serverState.followedProducts).toHaveLength(1);
    // user_lotteries作成に伴いデフォルトチェックリストが自動生成されている
    expect(body.serverState.checklistSteps).toHaveLength(5);
  });

  it("既に存在するデータは上書きせずconflictsに入る", async () => {
    const { accessToken } = await loginAs("sub-boot-2", "d1");
    const lotteryId = await insertLottery();

    await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "won", clientRequestId: crypto.randomUUID() }),
    });

    const res = await app.request("/me/sync/bootstrap", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        batchClientRequestId: crypto.randomUUID(),
        userLotteries: [{ lotteryId, status: "planned", clientRequestId: crypto.randomUUID() }],
      }),
    });
    const body = await res.json();
    expect(body.results.userLotteries.conflicts).toHaveLength(1);
    expect(body.results.userLotteries.conflicts[0].resolvedStatus).toBe("won");
  });

  it("同一batchClientRequestIdの再送は冪等（同じレスポンスを返す）", async () => {
    const { accessToken } = await loginAs("sub-boot-3", "d1");
    const lotteryId = await insertLottery();
    const batchClientRequestId = crypto.randomUUID();
    const payload = {
      batchClientRequestId,
      userLotteries: [{ lotteryId, status: "planned", clientRequestId: crypto.randomUUID() }],
    };

    const first = await app.request("/me/sync/bootstrap", { method: "POST", headers: authHeaders(accessToken), body: JSON.stringify(payload) });
    const firstBody = await first.json();

    const second = await app.request("/me/sync/bootstrap", { method: "POST", headers: authHeaders(accessToken), body: JSON.stringify(payload) });
    const secondBody = await second.json();
    expect(secondBody.syncId).toBe(firstBody.syncId);
  });

  it("同一batchClientRequestIdで異なるpayloadはIDEMPOTENCY_CONFLICT", async () => {
    const { accessToken } = await loginAs("sub-boot-4", "d1");
    const lotteryId = await insertLottery();
    const batchClientRequestId = crypto.randomUUID();

    await app.request("/me/sync/bootstrap", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ batchClientRequestId, userLotteries: [{ lotteryId, status: "planned", clientRequestId: crypto.randomUUID() }] }),
    });

    const res = await app.request("/me/sync/bootstrap", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ batchClientRequestId, userLotteries: [{ lotteryId, status: "applied", clientRequestId: crypto.randomUUID() }] }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("別端末が同時にbootstrapしても他ユーザーのデータへ混入しない", async () => {
    const userA = await loginAs("sub-boot-idor-a", "da");
    const userB = await loginAs("sub-boot-idor-b", "db");
    const lotteryId = await insertLottery();

    await Promise.all([
      app.request("/me/sync/bootstrap", {
        method: "POST",
        headers: authHeaders(userA.accessToken),
        body: JSON.stringify({ batchClientRequestId: crypto.randomUUID(), userLotteries: [{ lotteryId, status: "planned", clientRequestId: crypto.randomUUID() }] }),
      }),
      app.request("/me/sync/bootstrap", {
        method: "POST",
        headers: authHeaders(userB.accessToken),
        body: JSON.stringify({ batchClientRequestId: crypto.randomUUID(), userLotteries: [{ lotteryId, status: "won", clientRequestId: crypto.randomUUID() }] }),
      }),
    ]);

    const listA = await app.request("/me/lotteries", { method: "GET", headers: authHeaders(userA.accessToken) });
    const listB = await app.request("/me/lotteries", { method: "GET", headers: authHeaders(userB.accessToken) });
    const listABody = await listA.json();
    const listBBody = await listB.json();
    const itemA = listABody.items.find((i: { lotteryId: number }) => i.lotteryId === lotteryId);
    const itemB = listBBody.items.find((i: { lotteryId: number }) => i.lotteryId === lotteryId);
    expect(itemA.status).toBe("planned");
    expect(itemB.status).toBe("won");
  });

  it("配列最大件数を超えると422", async () => {
    const { accessToken } = await loginAs("sub-boot-limit", "d1");
    const items = Array.from({ length: 501 }, (_, i) => ({ lotteryId: i + 1, status: "planned", clientRequestId: crypto.randomUUID() }));
    const res = await app.request("/me/sync/bootstrap", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ batchClientRequestId: crypto.randomUUID(), userLotteries: items }),
    });
    expect(res.status).toBe(422);
  });
});

describe("POST /me/sync/bootstrap - legacyFollowedProductKeys（Mobile-G3互換処理）", () => {
  it("完全一致で1件だけ見つかった場合はpublicProductIdへ解決してフォローする", async () => {
    const { accessToken } = await loginAs("sub-legacy-1", "d1");
    const { publicProductId } = await insertProductWithAlias("レガシー商品A");

    const res = await app.request("/me/sync/bootstrap", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ batchClientRequestId: crypto.randomUUID(), legacyFollowedProductKeys: ["レガシー商品A"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.legacyFollowedProducts.resolved).toEqual([{ legacyKey: "レガシー商品A", publicProductId }]);
    expect(body.results.legacyFollowedProducts.unresolved).toEqual([]);
    expect(body.serverState.followedProducts).toHaveLength(1);
    // legacyFollowedProducts.resolvedは内部productId（整数）を含めず、publicProductIdのみを返す
    expect(Object.keys(body.results.legacyFollowedProducts.resolved[0]).sort()).toEqual(["legacyKey", "publicProductId"]);
  });

  it("0件一致は解決できずunresolvedに入り、再フォローを強制しない", async () => {
    const { accessToken } = await loginAs("sub-legacy-2", "d1");

    const res = await app.request("/me/sync/bootstrap", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ batchClientRequestId: crypto.randomUUID(), legacyFollowedProductKeys: ["存在しない商品"] }),
    });
    const body = await res.json();
    expect(body.results.legacyFollowedProducts.resolved).toEqual([]);
    expect(body.results.legacyFollowedProducts.unresolved).toEqual(["存在しない商品"]);
    expect(body.serverState.followedProducts).toHaveLength(0);
  });

  it("同じnormalizedAliasが複数商品を指す場合はあいまい一致とせずunresolvedに入る", async () => {
    const { accessToken } = await loginAs("sub-legacy-3", "d1");
    await insertProductWithAlias("あいまいな商品", "v1");
    await insertProductWithAlias("あいまいな商品", "v2");

    const res = await app.request("/me/sync/bootstrap", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ batchClientRequestId: crypto.randomUUID(), legacyFollowedProductKeys: ["あいまいな商品"] }),
    });
    const body = await res.json();
    expect(body.results.legacyFollowedProducts.unresolved).toEqual(["あいまいな商品"]);
    expect(body.serverState.followedProducts).toHaveLength(0);
  });

  it("既にフォロー済みの商品を指す場合も冪等に解決済み扱いになる", async () => {
    const { accessToken } = await loginAs("sub-legacy-4", "d1");
    const { publicProductId } = await insertProductWithAlias("既にフォロー済み");

    await app.request("/me/sync/bootstrap", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ batchClientRequestId: crypto.randomUUID(), followedProducts: [{ publicProductId, clientRequestId: crypto.randomUUID() }] }),
    });

    const res = await app.request("/me/sync/bootstrap", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ batchClientRequestId: crypto.randomUUID(), legacyFollowedProductKeys: ["既にフォロー済み"] }),
    });
    const body = await res.json();
    expect(body.results.legacyFollowedProducts.resolved).toEqual([{ legacyKey: "既にフォロー済み", publicProductId }]);
    expect(body.serverState.followedProducts).toHaveLength(1);
  });

  it("配列最大件数を超えると422", async () => {
    const { accessToken } = await loginAs("sub-legacy-limit", "d1");
    const keys = Array.from({ length: 501 }, (_, i) => `key-${i}`);
    const res = await app.request("/me/sync/bootstrap", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ batchClientRequestId: crypto.randomUUID(), legacyFollowedProductKeys: keys }),
    });
    expect(res.status).toBe(422);
  });
});
