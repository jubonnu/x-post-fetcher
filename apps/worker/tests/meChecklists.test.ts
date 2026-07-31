/**
 * Mobile-G2B-4: /me/checklists系の結合テスト。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { lotteries } from "../src/db/schema.ts";
import { __setAppleJwksResolverForTests } from "../src/auth/apple.ts";
import { __resetRateLimitForTests } from "../src/auth/rateLimit.ts";
import { TEST_APPLE_CLIENT_ID, createAppleTestKeyPair, makeAppleJwksResolver, signTestAppleToken } from "./helpers/appleTestKit.ts";
import type { KeyLike } from "jose";

const DB_FILE = resolve(process.cwd(), `.tmp-me-checklists-${Date.now()}.db`);

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

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function saveLottery(accessToken: string, lotteryId: number) {
  await app.request(`/me/lotteries/${lotteryId}`, {
    method: "PUT",
    headers: authHeaders(accessToken),
    body: JSON.stringify({ status: "planned", clientRequestId: crypto.randomUUID() }),
  });
}

describe("デフォルトステップ自動生成", () => {
  it("自分の抽選を保存すると5件のデフォルトステップが作られる", async () => {
    const { accessToken } = await loginAs("sub-cl-default", "d1");
    const lotteryId = await insertLottery();
    await saveLottery(accessToken, lotteryId);

    const res = await app.request(`/me/checklists/${lotteryId}`, { method: "GET", headers: authHeaders(accessToken) });
    const body = await res.json();
    expect(body.items).toHaveLength(5);
    expect(body.items.every((i: { isDefault: boolean }) => i.isDefault)).toBe(true);
    expect(body.items[0].stepId).toBe("default-0");
    expect(body.items.every((i: { done: boolean }) => i.done === false)).toBe(true);
  });
});

describe("PUT /me/checklists/:lotteryId", () => {
  it("複数stepを一括upsertできる（新規カスタムstep）", async () => {
    const { accessToken } = await loginAs("sub-cl-1", "d1");
    const lotteryId = await insertLottery();
    await saveLottery(accessToken, lotteryId);

    const res = await app.request(`/me/checklists/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        steps: [
          { stepId: "custom-1", label: "独自ステップ", done: false, expectedServerVersion: 0, clientRequestId: crypto.randomUUID() },
          { stepId: "default-0", label: "応募条件を確認", done: true, expectedServerVersion: 1, clientRequestId: crypto.randomUUID() },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    expect(body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    const defaultResult = body.results.find((r: { stepId: string }) => r.stepId === "default-0");
    expect(defaultResult.done).toBe(true);
    expect(defaultResult.completedAt).toEqual(expect.any(String));
  });

  it("done falseにするとcompletedAtがnullに戻る", async () => {
    const { accessToken } = await loginAs("sub-cl-2", "d1");
    const lotteryId = await insertLottery();
    await saveLottery(accessToken, lotteryId);

    await app.request(`/me/checklists/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ steps: [{ stepId: "default-1", label: "応募を完了する", done: true, expectedServerVersion: 1, clientRequestId: crypto.randomUUID() }] }),
    });

    const res = await app.request(`/me/checklists/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ steps: [{ stepId: "default-1", label: "応募を完了する", done: false, expectedServerVersion: 2, clientRequestId: crypto.randomUUID() }] }),
    });
    const body = await res.json();
    expect(body.results[0].done).toBe(false);
    expect(body.results[0].completedAt).toBeNull();
  });

  it("expectedServerVersion不一致は該当stepのみVERSION_CONFLICTで部分成功する", async () => {
    const { accessToken } = await loginAs("sub-cl-3", "d1");
    const lotteryId = await insertLottery();
    await saveLottery(accessToken, lotteryId);

    const res = await app.request(`/me/checklists/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        steps: [
          { stepId: "default-0", label: "応募条件を確認", done: true, expectedServerVersion: 999, clientRequestId: crypto.randomUUID() },
          { stepId: "default-1", label: "応募を完了する", done: true, expectedServerVersion: 1, clientRequestId: crypto.randomUUID() },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const conflict = body.results.find((r: { stepId: string }) => r.stepId === "default-0");
    const ok = body.results.find((r: { stepId: string }) => r.stepId === "default-1");
    expect(conflict.ok).toBe(false);
    expect(conflict.error.code).toBe("VERSION_CONFLICT");
    expect(ok.ok).toBe(true);
  });

  it("同時更新は片方だけ成功する", async () => {
    const { accessToken } = await loginAs("sub-cl-race", "d1");
    const lotteryId = await insertLottery();
    await saveLottery(accessToken, lotteryId);

    const attempt = () =>
      app.request(`/me/checklists/${lotteryId}`, {
        method: "PUT",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ steps: [{ stepId: "default-2", label: "当選結果を確認", done: true, expectedServerVersion: 1, clientRequestId: crypto.randomUUID() }] }),
      });
    const [a, b] = await Promise.all([attempt(), attempt()]);
    const [bodyA, bodyB] = await Promise.all([a.json(), b.json()]);
    const oks = [bodyA.results[0].ok, bodyB.results[0].ok];
    expect(oks.filter(Boolean)).toHaveLength(1);
  });

  it("同一clientRequestIdの再送は冪等（同じ結果を返す、再適用されない）", async () => {
    const { accessToken } = await loginAs("sub-cl-idem", "d1");
    const lotteryId = await insertLottery();
    await saveLottery(accessToken, lotteryId);
    const clientRequestId = crypto.randomUUID();

    const payload = { steps: [{ stepId: "default-3", label: "購入手続きをする", done: true, expectedServerVersion: 1, clientRequestId }] };
    const first = await app.request(`/me/checklists/${lotteryId}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify(payload) });
    const firstBody = await first.json();

    const second = await app.request(`/me/checklists/${lotteryId}`, { method: "PUT", headers: authHeaders(accessToken), body: JSON.stringify(payload) });
    const secondBody = await second.json();
    expect(secondBody.results[0].serverVersion).toBe(firstBody.results[0].serverVersion);
  });

  it("同一clientRequestIdで異なるpayloadはIDEMPOTENCY_CONFLICT", async () => {
    const { accessToken } = await loginAs("sub-cl-idem-conflict", "d1");
    const lotteryId = await insertLottery();
    await saveLottery(accessToken, lotteryId);
    const clientRequestId = crypto.randomUUID();

    await app.request(`/me/checklists/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ steps: [{ stepId: "default-4", label: "受け取り・開封記録", done: true, expectedServerVersion: 1, clientRequestId }] }),
    });

    const res = await app.request(`/me/checklists/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ steps: [{ stepId: "default-4", label: "受け取り・開封記録", done: false, expectedServerVersion: 1, clientRequestId }] }),
    });
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("ステップ数上限を超えるとVALIDATION_ERROR", async () => {
    const { accessToken } = await loginAs("sub-cl-limit", "d1");
    const lotteryId = await insertLottery();
    await saveLottery(accessToken, lotteryId);

    // 既に5件のデフォルトが存在するため、25件追加でちょうど上限(30)、26件目でエラー
    const steps = Array.from({ length: 26 }, (_, i) => ({
      stepId: `custom-limit-${i}`,
      label: "追加ステップ",
      done: false,
      expectedServerVersion: 0,
      clientRequestId: crypto.randomUUID(),
    }));

    const res = await app.request(`/me/checklists/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ steps }),
    });
    const body = await res.json();
    const failed = body.results.filter((r: { ok: boolean }) => !r.ok);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0].error.code).toBe("VALIDATION_ERROR");
  });

  it("label/note文字数上限を超えると422", async () => {
    const { accessToken } = await loginAs("sub-cl-toolong", "d1");
    const lotteryId = await insertLottery();
    await saveLottery(accessToken, lotteryId);

    const res = await app.request(`/me/checklists/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ steps: [{ stepId: "custom-toolong", label: "x".repeat(300), done: false, expectedServerVersion: 0, clientRequestId: crypto.randomUUID() }] }),
    });
    expect(res.status).toBe(422);
  });

  it("保存されていない抽選へのPUTは404", async () => {
    const { accessToken } = await loginAs("sub-cl-404", "d1");
    const lotteryId = await insertLottery();
    const res = await app.request(`/me/checklists/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ steps: [{ stepId: "custom-x", label: "x", done: false, expectedServerVersion: 0, clientRequestId: crypto.randomUUID() }] }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /me/checklists/:lotteryId/:stepId", () => {
  it("デフォルトステップは削除できない", async () => {
    const { accessToken } = await loginAs("sub-cl-del-default", "d1");
    const lotteryId = await insertLottery();
    await saveLottery(accessToken, lotteryId);

    const res = await app.request(`/me/checklists/${lotteryId}/default-0`, {
      method: "DELETE",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(409);
  });

  it("カスタムステップは削除できる", async () => {
    const { accessToken } = await loginAs("sub-cl-del-custom", "d1");
    const lotteryId = await insertLottery();
    await saveLottery(accessToken, lotteryId);
    await app.request(`/me/checklists/${lotteryId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ steps: [{ stepId: "custom-del", label: "削除対象", done: false, expectedServerVersion: 0, clientRequestId: crypto.randomUUID() }] }),
    });

    const res = await app.request(`/me/checklists/${lotteryId}/custom-del`, {
      method: "DELETE",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(200);

    const list = await app.request(`/me/checklists/${lotteryId}`, { method: "GET", headers: authHeaders(accessToken) });
    const listBody = await list.json();
    expect(listBody.items.find((i: { stepId: string }) => i.stepId === "custom-del")).toBeUndefined();
  });

  it("他ユーザーのチェックリストは操作できない", async () => {
    const userA = await loginAs("sub-cl-idor-a", "da");
    const userB = await loginAs("sub-cl-idor-b", "db");
    const lotteryId = await insertLottery();
    await saveLottery(userA.accessToken, lotteryId);

    const listB = await app.request(`/me/checklists/${lotteryId}`, { method: "GET", headers: authHeaders(userB.accessToken) });
    const listBBody = await listB.json();
    expect(listBBody.items).toHaveLength(0);

    const del = await app.request(`/me/checklists/${lotteryId}/custom-x`, {
      method: "DELETE",
      headers: authHeaders(userB.accessToken),
      body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
    });
    expect(del.status).toBe(404);
  });
});
