/**
 * Mobile-G2B-2: /me/lotteries系（自分の抽選）の結合テスト。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { lotteries, userLotteryStatusHistory } from "../src/db/schema.ts";
import { __setAppleJwksResolverForTests } from "../src/auth/apple.ts";
import { __resetRateLimitForTests } from "../src/auth/rateLimit.ts";
import { TEST_APPLE_CLIENT_ID, createAppleTestKeyPair, makeAppleJwksResolver, signTestAppleToken } from "./helpers/appleTestKit.ts";
import type { KeyLike } from "jose";

const DB_FILE = resolve(process.cwd(), `.tmp-me-lotteries-${Date.now()}.db`);

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

describe("PUT /me/lotteries/:lotteryId", () => {
  it("新規保存できる", async () => {
    const { accessToken } = await loginAs("sub-lot-1", "device-1");
    const lotteryId = await insertLottery();

    const res = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("planned");
    expect(body.serverVersion).toBe(1);
    expect(body.outcome).toBe("created");
  });

  it("存在しないlotteryIdは404", async () => {
    const { accessToken } = await loginAs("sub-lot-404", "device-1");
    const res = await app.request(`/me/lotteries/999999`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(404);
  });

  it("expectedServerVersion一致で更新でき、serverVersionが+1される", async () => {
    const { accessToken } = await loginAs("sub-lot-2", "device-1");
    const lotteryId = await insertLottery();
    const create = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: crypto.randomUUID() }),
    });
    const createBody = await create.json();

    const update = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "applied", expectedServerVersion: createBody.serverVersion, clientRequestId: crypto.randomUUID() }),
    });
    expect(update.status).toBe(200);
    const updateBody = await update.json();
    expect(updateBody.status).toBe("applied");
    expect(updateBody.serverVersion).toBe(2);
  });

  it("不正な状態遷移は422", async () => {
    const { accessToken } = await loginAs("sub-lot-invalid-transition", "device-1");
    const lotteryId = await insertLottery();
    const create = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "lost", clientRequestId: crypto.randomUUID() }),
    });
    const createBody = await create.json();

    const res = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "applied", expectedServerVersion: createBody.serverVersion, clientRequestId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(422);
  });

  it("expectedServerVersion不一致は409 VERSION_CONFLICTでサーバー側の現在値を返す", async () => {
    const { accessToken } = await loginAs("sub-lot-conflict", "device-1");
    const lotteryId = await insertLottery();
    await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: crypto.randomUUID() }),
    });

    const res = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "applied", expectedServerVersion: 999, clientRequestId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("VERSION_CONFLICT");
    expect(body.current.status).toBe("planned");
  });

  it("同時更新は片方だけ成功する", async () => {
    const { accessToken } = await loginAs("sub-lot-race", "device-1");
    const lotteryId = await insertLottery();
    const create = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: crypto.randomUUID() }),
    });
    const createBody = await create.json();

    const attempt = () =>
      app.request(`/me/lotteries/${lotteryId}`, {
        method: "PUT",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ status: "applied", expectedServerVersion: createBody.serverVersion, clientRequestId: crypto.randomUUID() }),
      });
    const [a, b] = await Promise.all([attempt(), attempt()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("同一clientRequestIdの再送は冪等（再適用されない）", async () => {
    const { accessToken } = await loginAs("sub-lot-idem", "device-1");
    const lotteryId = await insertLottery();
    const clientRequestId = crypto.randomUUID();
    const first = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId }),
    });
    const firstBody = await first.json();

    const second = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId }),
    });
    const secondBody = await second.json();
    expect(secondBody.serverVersion).toBe(firstBody.serverVersion);
  });

  it("snapshotサイズ超過は422", async () => {
    const { accessToken } = await loginAs("sub-lot-snapshot-big", "device-1");
    const lotteryId = await insertLottery();
    const snapshot = {
      id: lotteryId,
      sourcePostId: null,
      productNameRaw: "x".repeat(500),
      normalizedProductName: "x".repeat(500),
      cardType: null,
      storeNameRaw: "x".repeat(500),
      normalizedStoreName: "x".repeat(500),
      storeBranchRaw: "x".repeat(500),
      normalizedStoreBranch: "x".repeat(500),
      region: null,
      normalizerVersion: null,
      applicationStartAt: null,
      confirmedOpenAt: null,
      applicationEndAt: null,
      applicationEndDate: null,
      applicationEndPrecision: null,
      resultAnnouncementAt: null,
      resultAnnouncementDate: null,
      resultAnnouncementPrecision: null,
      purchaseStartAt: null,
      purchaseDeadlineAt: null,
      applicationUrl: "x".repeat(2000),
      resolvedApplicationUrl: "x".repeat(2000),
      applicationUrlHttpStatus: null,
      urlResolvedAt: null,
      officialInformationUrl: "x".repeat(2000),
      appDownloadUrl: "x".repeat(2000),
      applicationMethod: "x".repeat(2000),
      eligibilityConditions: "x".repeat(2000),
      pickupMethod: "x".repeat(2000),
      paymentMethod: "x".repeat(500),
      price: null,
      status: null,
      completenessScore: null,
      verificationStatus: null,
      approvedBy: null,
      approvedAt: null,
      rejectedReason: "x".repeat(2000),
      rejectedAt: null,
      lifecycleStatus: "active",
      orphanedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const res = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", snapshot, clientRequestId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(422);
  });

  it("他ユーザーのデータへはアクセスできない", async () => {
    const userA = await loginAs("sub-lot-idor-a", "device-a");
    const userB = await loginAs("sub-lot-idor-b", "device-b");
    const lotteryId = await insertLottery();

    await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(userA.accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: crypto.randomUUID() }),
    });

    const listB = await app.request(`/me/lotteries`, { method: "GET", headers: authHeaders(userB.accessToken) });
    const listBBody = await listB.json();
    expect(listBBody.items.find((i: { lotteryId: number }) => i.lotteryId === lotteryId)).toBeUndefined();

    // Bが同じlotteryIdへPATCHしようとしても、Bにとっては未保存のためNOT_FOUND
    const patchB = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PATCH",
      headers: authHeaders(userB.accessToken),
      body: JSON.stringify({ status: "applied", expectedServerVersion: 1, clientRequestId: crypto.randomUUID() }),
    });
    expect(patchB.status).toBe(404);
  });
});

describe("DELETE /me/lotteries/:lotteryId + 復元", () => {
  it("論理削除でき、GET一覧から消える", async () => {
    const { accessToken } = await loginAs("sub-lot-del-1", "device-1");
    const lotteryId = await insertLottery();
    await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: crypto.randomUUID() }),
    });

    const del = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "DELETE",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
    });
    expect(del.status).toBe(200);

    const list = await app.request(`/me/lotteries`, { method: "GET", headers: authHeaders(accessToken) });
    const listBody = await list.json();
    expect(listBody.items.find((i: { lotteryId: number }) => i.lotteryId === lotteryId)).toBeUndefined();
  });

  it("再削除は冪等（成功のまま）", async () => {
    const { accessToken } = await loginAs("sub-lot-del-2", "device-1");
    const lotteryId = await insertLottery();
    await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: crypto.randomUUID() }),
    });
    await app.request(`/me/lotteries/${lotteryId}`, {
      method: "DELETE",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
    });
    const second = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "DELETE",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
    });
    expect(second.status).toBe(200);
  });

  it("削除後に再PUTすると新規行を作らずに復元される", async () => {
    const { accessToken } = await loginAs("sub-lot-restore", "device-1");
    const lotteryId = await insertLottery();
    const create = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: crypto.randomUUID() }),
    });
    const createBody = await create.json();

    await app.request(`/me/lotteries/${lotteryId}`, {
      method: "DELETE",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
    });

    const restore = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "applied", clientRequestId: crypto.randomUUID() }),
    });
    expect(restore.status).toBe(200);
    const restoreBody = await restore.json();
    expect(restoreBody.outcome).toBe("restored");

    const list = await app.request(`/me/lotteries`, { method: "GET", headers: authHeaders(accessToken) });
    const listBody = await list.json();
    const matches = listBody.items.filter((i: { lotteryId: number }) => i.lotteryId === lotteryId);
    expect(matches).toHaveLength(1); // 新規行が増えていない
    expect(matches[0].status).toBe("applied");
    void createBody;
  });
});

describe("履歴追加", () => {
  it("status変更ごとにuser_lottery_status_historyへ追加される", async () => {
    const { accessToken } = await loginAs("sub-lot-history", "device-1");
    const lotteryId = await insertLottery();
    const create = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: crypto.randomUUID() }),
    });
    const createBody = await create.json();
    await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PATCH",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "applied", expectedServerVersion: createBody.serverVersion, clientRequestId: crypto.randomUUID() }),
    });

    const list = await app.request(`/me/lotteries`, { method: "GET", headers: authHeaders(accessToken) });
    const listBody = await list.json();
    const saved = listBody.items.find((i: { lotteryId: number }) => i.lotteryId === lotteryId);

    const rows = await db.select().from(userLotteryStatusHistory);
    const relevant = rows.filter((r) => r.toStatus === "applied" && r.fromStatus === "planned");
    expect(relevant.length).toBeGreaterThanOrEqual(1);
    expect(saved.status).toBe("applied");
  });
});

describe("POST /me/lotteries/sync", () => {
  it("新規lotteryIdは無条件マージされる", async () => {
    const { accessToken } = await loginAs("sub-lot-sync-1", "device-1");
    const lotteryId = await insertLottery();

    const res = await app.request(`/me/lotteries/sync`, {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ items: [{ lotteryId, status: "planned", clientRequestId: crypto.randomUUID() }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merged).toHaveLength(1);
    expect(body.conflicts).toHaveLength(0);
  });

  it("既にサーバー側に有効行がある場合はconflictsに入り上書きしない", async () => {
    const { accessToken } = await loginAs("sub-lot-sync-2", "device-1");
    const lotteryId = await insertLottery();
    await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "won", clientRequestId: crypto.randomUUID() }),
    });

    const res = await app.request(`/me/lotteries/sync`, {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ items: [{ lotteryId, status: "planned", clientRequestId: crypto.randomUUID() }] }),
    });
    const body = await res.json();
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0].resolvedStatus).toBe("won");
  });

  it("同一batchの再送は冪等", async () => {
    const { accessToken } = await loginAs("sub-lot-sync-3", "device-1");
    const lotteryId = await insertLottery();
    const clientRequestId = crypto.randomUUID();

    const first = await app.request(`/me/lotteries/sync`, {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ items: [{ lotteryId, status: "planned", clientRequestId }] }),
    });
    const firstBody = await first.json();

    const second = await app.request(`/me/lotteries/sync`, {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ items: [{ lotteryId, status: "planned", clientRequestId }] }),
    });
    const secondBody = await second.json();
    expect(secondBody.merged).toHaveLength(1);
    expect(secondBody.merged[0].serverVersion).toBe(firstBody.merged[0].serverVersion);
  });

  it("他ユーザーのデータへ混入しない", async () => {
    const userA = await loginAs("sub-lot-sync-idor-a", "device-a");
    const userB = await loginAs("sub-lot-sync-idor-b", "device-b");
    const lotteryId = await insertLottery();

    await app.request(`/me/lotteries/sync`, {
      method: "POST",
      headers: authHeaders(userA.accessToken),
      body: JSON.stringify({ items: [{ lotteryId, status: "planned", clientRequestId: crypto.randomUUID() }] }),
    });

    const listB = await app.request(`/me/lotteries`, { method: "GET", headers: authHeaders(userB.accessToken) });
    const listBBody = await listB.json();
    expect(listBBody.items.find((i: { lotteryId: number }) => i.lotteryId === lotteryId)).toBeUndefined();
  });
});
