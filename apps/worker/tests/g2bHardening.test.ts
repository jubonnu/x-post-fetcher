/**
 * Mobile-G2B-Hardening: idempotency_records台帳の全面適用（古い操作の遅延再送防止）、
 * 行ID保持（論理削除→復元でも同一行を再利用する）の検証。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { lotteries, products, userLotteryStatusHistory, userLotteries, checklistProgress } from "../src/db/schema.ts";
import { __setAppleJwksResolverForTests } from "../src/auth/apple.ts";
import { __resetRateLimitForTests } from "../src/auth/rateLimit.ts";
import { TEST_APPLE_CLIENT_ID, createAppleTestKeyPair, makeAppleJwksResolver, signTestAppleToken } from "./helpers/appleTestKit.ts";
import type { KeyLike } from "jose";

const DB_FILE = resolve(process.cwd(), `.tmp-g2b-hardening-${Date.now()}.db`);

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
  const [row] = await db.insert(products).values({ publicProductId: crypto.randomUUID(), canonicalName: "商品Z", normalizedName: "商品Z" }).returning();
  return row.publicProductId;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("古い操作の遅延再送に耐える冪等性（追加→削除→古い追加の再送）", () => {
  it("user_lotteries: 削除後に古いPUT(追加)が遅延再送されても復元されない", async () => {
    const { accessToken } = await loginAs("sub-hard-lot-1", "d1");
    const lotteryId = await insertLottery();
    const reqA = crypto.randomUUID();

    const putA = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: reqA }),
    });
    expect(putA.status).toBe(200);

    const del = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "DELETE",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
    });
    expect(del.status).toBe(200);

    // 通信遅延により古いPUT(reqA)が再送される
    const staleReplay = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: reqA }),
    });
    expect(staleReplay.status).toBe(200); // 台帳キャッシュヒットで前回結果をそのまま返す

    const list = await app.request(`/me/lotteries`, { method: "GET", headers: authHeaders(accessToken) });
    const listBody = await list.json();
    expect(listBody.items.find((i: { lotteryId: number }) => i.lotteryId === lotteryId)).toBeUndefined(); // 削除済みのまま
  });

  it("user_favorites: 削除後に古いPUT(追加)が遅延再送されても復元されない", async () => {
    const { accessToken } = await loginAs("sub-hard-fav-1", "d1");
    const lotteryId = await insertLottery();
    const reqA = crypto.randomUUID();

    await app.request(`/me/favorites/${lotteryId}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: reqA }) });
    await app.request(`/me/favorites/${lotteryId}`, { method: "DELETE", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });

    const staleReplay = await app.request(`/me/favorites/${lotteryId}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: reqA }) });
    expect(staleReplay.status).toBe(200);

    const list = await app.request(`/me/favorites`, { method: "GET", headers: authHeaders(accessToken) });
    const listBody = await list.json();
    expect(listBody.items.find((i: { lotteryId: number }) => i.lotteryId === lotteryId)).toBeUndefined();
  });

  it("followed_products: 削除後に古いPUT(追加)が遅延再送されても復元されない", async () => {
    const { accessToken } = await loginAs("sub-hard-follow-1", "d1");
    const publicProductId = await insertProduct();
    const reqA = crypto.randomUUID();

    await app.request(`/me/followed-products/${publicProductId}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: reqA }) });
    await app.request(`/me/followed-products/${publicProductId}`, { method: "DELETE", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });

    const staleReplay = await app.request(`/me/followed-products/${publicProductId}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: reqA }) });
    expect(staleReplay.status).toBe(200);

    const list = await app.request(`/me/followed-products`, { method: "GET", headers: authHeaders(accessToken) });
    const listBody = await list.json();
    expect(listBody.items.find((i: { publicProductId: string }) => i.publicProductId === publicProductId)).toBeUndefined();
  });

  it("notification_preferences: 古いPUTが後発PUTの後に遅延再送されても現在の値を上書きしない", async () => {
    const { accessToken } = await loginAs("sub-hard-notif-1", "d1");
    const reqA = crypto.randomUUID();
    const basePrefs = {
      deadlineReminder: true,
      announcementReminder: true,
      purchaseReminder: true,
      newLotteryAlert: true,
      favoriteUpdateAlert: false,
      pushEnabled: true,
      emailEnabled: false,
      quietHoursEnabled: true,
      quietHoursStart: "23:00",
      quietHoursEnd: "07:00",
      deadlineReminderHoursBefore: 3,
      announcementReminderHoursBefore: 6,
      purchaseReminderHoursBefore: 6,
    };

    const first = await app.request("/me/notification-preferences", {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ ...basePrefs, pushEnabled: true, clientRequestId: reqA }),
    });
    const firstBody = await first.json();

    const second = await app.request("/me/notification-preferences", {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ ...basePrefs, pushEnabled: false, expectedServerVersion: firstBody.serverVersion, clientRequestId: crypto.randomUUID() }),
    });
    expect(second.status).toBe(200);

    // 古いreqA（pushEnabled:trueの内容）が遅延再送される。台帳ヒットで前回(1回目)の結果をそのまま
    // 返すのみで、現在の状態（2回目でpushEnabled:falseにした値）を上書きしない。
    const staleReplay = await app.request("/me/notification-preferences", {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ ...basePrefs, pushEnabled: true, clientRequestId: reqA }),
    });
    expect(staleReplay.status).toBe(200);

    const get = await app.request("/me/notification-preferences", { method: "GET", headers: authHeaders(accessToken) });
    const getBody = await get.json();
    expect(getBody.pushEnabled).toBe(false); // 現在状態は変化しない
    expect(getBody.serverVersion).toBe(2);
  });
});

describe("同一clientRequestIdの誤用検知", () => {
  it("異なるoperationType（PUT→DELETE）への誤用は409 IDEMPOTENCY_CONFLICT", async () => {
    const { accessToken } = await loginAs("sub-hard-optype", "d1");
    const lotteryId = await insertLottery();
    const reusedId = crypto.randomUUID();

    const put = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: reusedId }),
    });
    expect(put.status).toBe(200);

    const del = await app.request(`/me/lotteries/${lotteryId}`, {
      method: "DELETE",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ clientRequestId: reusedId }),
    });
    expect(del.status).toBe(409);
    const delBody = await del.json();
    expect(delBody.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("異なるresourceKey（別のlotteryId）への誤用は409 IDEMPOTENCY_CONFLICT", async () => {
    const { accessToken } = await loginAs("sub-hard-reskey", "d1");
    const lotteryId1 = await insertLottery();
    const lotteryId2 = await insertLottery();
    const reusedId = crypto.randomUUID();

    const put1 = await app.request(`/me/lotteries/${lotteryId1}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: reusedId }),
    });
    expect(put1.status).toBe(200);

    const put2 = await app.request(`/me/lotteries/${lotteryId2}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: reusedId }),
    });
    expect(put2.status).toBe(409);
    const put2Body = await put2.json();
    expect(put2Body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("同一clientRequestIdで異なるpayload（favorite）は409 IDEMPOTENCY_CONFLICT", async () => {
    const { accessToken } = await loginAs("sub-hard-payload-fav", "d1");
    const lotteryId1 = await insertLottery();
    const lotteryId2 = await insertLottery();
    const reusedId = crypto.randomUUID();

    await app.request(`/me/favorites/${lotteryId1}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: reusedId }) });
    const conflict = await app.request(`/me/favorites/${lotteryId2}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: reusedId }) });
    expect(conflict.status).toBe(409);
  });
});

describe("論理削除行の行ID保持", () => {
  it("追加→削除→復元を10回繰り返しても行数は1件、行IDも変わらない", async () => {
    const { accessToken } = await loginAs("sub-hard-cycle", "d1");
    const lotteryId = await insertLottery();

    await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: crypto.randomUUID() }),
    });
    const [firstRow] = await db.select().from(userLotteries).where(eq(userLotteries.lotteryId, lotteryId));
    const originalId = firstRow.id;

    for (let i = 0; i < 10; i++) {
      await app.request(`/me/lotteries/${lotteryId}`, {
        method: "DELETE",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
      });
      await app.request(`/me/lotteries/${lotteryId}`, {
        method: "PUT",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ status: "planned", clientRequestId: crypto.randomUUID() }),
      });
    }

    const rows = await db.select().from(userLotteries).where(eq(userLotteries.lotteryId, lotteryId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(originalId);
  });

  it("復元後もuser_lottery_status_historyの参照先IDが維持される", async () => {
    const { accessToken } = await loginAs("sub-hard-history-ref", "d1");
    const lotteryId = await insertLottery();

    await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: crypto.randomUUID() }),
    });
    const [row] = await db.select().from(userLotteries).where(eq(userLotteries.lotteryId, lotteryId));

    await app.request(`/me/lotteries/${lotteryId}`, {
      method: "DELETE",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
    });
    await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "applied", clientRequestId: crypto.randomUUID() }),
    });

    const historyRows = await db.select().from(userLotteryStatusHistory).where(eq(userLotteryStatusHistory.userLotteryId, row.id));
    expect(historyRows.length).toBeGreaterThanOrEqual(2); // 作成時 + 復元時のstatus変更
    // すべての履歴行が同一のuser_lottery行を指している（行IDが変わっていない証拠）
    for (const h of historyRows) {
      expect(h.userLotteryId).toBe(row.id);
    }
  });

  it("checklist_progressの復元でも同じstepId・行IDが維持される", async () => {
    const { accessToken } = await loginAs("sub-hard-checklist-restore", "d1");
    const lotteryId = await insertLottery();
    await app.request(`/me/lotteries/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "planned", clientRequestId: crypto.randomUUID() }),
    });

    // カスタムstepを追加
    await app.request(`/me/checklists/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ steps: [{ stepId: "custom-restore", label: "カスタム", done: false, expectedServerVersion: 0, clientRequestId: crypto.randomUUID() }] }),
    });
    const [beforeRow] = await db.select().from(checklistProgress).where(eq(checklistProgress.stepId, "custom-restore"));

    await app.request(`/me/checklists/${lotteryId}/custom-restore`, {
      method: "DELETE",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
    });

    // 同じstepIdで再度PUT（復元）
    await app.request(`/me/checklists/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ steps: [{ stepId: "custom-restore", label: "カスタム", done: true, expectedServerVersion: 0, clientRequestId: crypto.randomUUID() }] }),
    });

    const afterRows = await db.select().from(checklistProgress).where(eq(checklistProgress.stepId, "custom-restore"));
    expect(afterRows).toHaveLength(1); // 新規行が増えていない
    expect(afterRows[0].id).toBe(beforeRow.id); // 行IDが維持されている
    expect(afterRows[0].done).toBe(true);
  });
});

describe("同時実行での重複防止", () => {
  it("同時追加(user_lotteries)しても行は1件のみ", async () => {
    const { accessToken } = await loginAs("sub-hard-concurrent-lot", "d1");
    const lotteryId = await insertLottery();

    const attempt = () =>
      app.request(`/me/lotteries/${lotteryId}`, {
        method: "PUT",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ status: "planned", clientRequestId: crypto.randomUUID() }),
      });
    const [a, b] = await Promise.all([attempt(), attempt()]);
    expect([a.status, b.status].every((s) => s === 200 || s === 409)).toBe(true);

    const rows = await db.select().from(userLotteries).where(eq(userLotteries.lotteryId, lotteryId));
    expect(rows).toHaveLength(1);
  });

  it("同時復元(favorites)しても行は1件のみ", async () => {
    const { accessToken } = await loginAs("sub-hard-concurrent-restore", "d1");
    const lotteryId = await insertLottery();
    await app.request(`/me/favorites/${lotteryId}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });
    await app.request(`/me/favorites/${lotteryId}`, { method: "DELETE", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });

    const attempt = () => app.request(`/me/favorites/${lotteryId}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });
    const [a, b] = await Promise.all([attempt(), attempt()]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const list = await app.request(`/me/favorites`, { method: "GET", headers: authHeaders(accessToken) });
    const listBody = await list.json();
    expect(listBody.items.filter((i: { lotteryId: number }) => i.lotteryId === lotteryId)).toHaveLength(1);
  });
});

describe("冪等性台帳との組み合わせ", () => {
  it("同一batchClientRequestIdのbootstrap再送は冪等（DB二重適用されない）", async () => {
    const { accessToken } = await loginAs("sub-hard-bootstrap-idem", "d1");
    const lotteryId = await insertLottery();
    const batchClientRequestId = crypto.randomUUID();
    const payload = { batchClientRequestId, userLotteries: [{ lotteryId, status: "planned", clientRequestId: crypto.randomUUID() }] };

    await app.request("/me/sync/bootstrap", { method: "POST", headers: authHeaders(accessToken), body: JSON.stringify(payload) });
    await app.request("/me/sync/bootstrap", { method: "POST", headers: authHeaders(accessToken), body: JSON.stringify(payload) });

    const rows = await db.select().from(userLotteries).where(eq(userLotteries.lotteryId, lotteryId));
    expect(rows).toHaveLength(1);
  });
});
