/**
 * Mobile-G2B-5: /me/notification-preferences の結合テスト。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { __setAppleJwksResolverForTests } from "../src/auth/apple.ts";
import { __resetRateLimitForTests } from "../src/auth/rateLimit.ts";
import { TEST_APPLE_CLIENT_ID, createAppleTestKeyPair, makeAppleJwksResolver, signTestAppleToken } from "./helpers/appleTestKit.ts";
import type { KeyLike } from "jose";

const DB_FILE = resolve(process.cwd(), `.tmp-me-notif-prefs-${Date.now()}.db`);

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

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

const validPrefs = {
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

describe("GET /me/notification-preferences", () => {
  it("未保存時は仮想デフォルトをserverVersion=0で返す（DB行は作られない）", async () => {
    const { accessToken } = await loginAs("sub-notif-1", "d1");
    const res = await app.request("/me/notification-preferences", { method: "GET", headers: authHeaders(accessToken) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.serverVersion).toBe(0);
    expect(body.deadlineReminder).toBe(true);
    expect(body.quietHoursStart).toBe("23:00");
  });
});

describe("PUT /me/notification-preferences", () => {
  it("初回PUTで永続化される", async () => {
    const { accessToken } = await loginAs("sub-notif-2", "d1");
    const res = await app.request("/me/notification-preferences", {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ ...validPrefs, favoriteUpdateAlert: true, clientRequestId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.serverVersion).toBe(1);
    expect(body.favoriteUpdateAlert).toBe(true);

    const get = await app.request("/me/notification-preferences", { method: "GET", headers: authHeaders(accessToken) });
    const getBody = await get.json();
    expect(getBody.serverVersion).toBe(1);
    expect(getBody.favoriteUpdateAlert).toBe(true);
  });

  it("expectedServerVersion一致で更新でき、不一致は409 VERSION_CONFLICT", async () => {
    const { accessToken } = await loginAs("sub-notif-3", "d1");
    const first = await app.request("/me/notification-preferences", {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ ...validPrefs, clientRequestId: crypto.randomUUID() }),
    });
    const firstBody = await first.json();

    const ok = await app.request("/me/notification-preferences", {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ ...validPrefs, pushEnabled: false, expectedServerVersion: firstBody.serverVersion, clientRequestId: crypto.randomUUID() }),
    });
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(okBody.serverVersion).toBe(2);
    expect(okBody.pushEnabled).toBe(false);

    const conflict = await app.request("/me/notification-preferences", {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ ...validPrefs, expectedServerVersion: 999, clientRequestId: crypto.randomUUID() }),
    });
    expect(conflict.status).toBe(409);
    const conflictBody = await conflict.json();
    expect(conflictBody.error.code).toBe("VERSION_CONFLICT");
    expect(conflictBody.current.serverVersion).toBe(2);
  });

  it("自動マージせず、後着は常に409（複数端末の競合シナリオ）", async () => {
    const { accessToken } = await loginAs("sub-notif-4", "d1");
    const create = await app.request("/me/notification-preferences", {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ ...validPrefs, clientRequestId: crypto.randomUUID() }),
    });
    const createBody = await create.json();

    const attempt = (overrides: Record<string, unknown>) =>
      app.request("/me/notification-preferences", {
        method: "PUT",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ ...validPrefs, ...overrides, expectedServerVersion: createBody.serverVersion, clientRequestId: crypto.randomUUID() }),
      });

    const [a, b] = await Promise.all([attempt({ pushEnabled: false }), attempt({ emailEnabled: true })]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("同一clientRequestIdの再送は冪等", async () => {
    const { accessToken } = await loginAs("sub-notif-5", "d1");
    const clientRequestId = crypto.randomUUID();
    const first = await app.request("/me/notification-preferences", {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ ...validPrefs, clientRequestId }),
    });
    const firstBody = await first.json();

    const second = await app.request("/me/notification-preferences", {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ ...validPrefs, clientRequestId }),
    });
    const secondBody = await second.json();
    expect(secondBody.serverVersion).toBe(firstBody.serverVersion);
  });

  it("quietHoursの形式が不正なら422", async () => {
    const { accessToken } = await loginAs("sub-notif-6", "d1");
    const res = await app.request("/me/notification-preferences", {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ ...validPrefs, quietHoursStart: "not-a-time", clientRequestId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(422);
  });

  it("reminderHoursBeforeが範囲外なら422", async () => {
    const { accessToken } = await loginAs("sub-notif-7", "d1");
    const res = await app.request("/me/notification-preferences", {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ ...validPrefs, deadlineReminderHoursBefore: 9999, clientRequestId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(422);
  });

  it("他ユーザーの設定は独立している", async () => {
    const userA = await loginAs("sub-notif-idor-a", "da");
    const userB = await loginAs("sub-notif-idor-b", "db");

    await app.request("/me/notification-preferences", {
      method: "PUT",
      headers: authHeaders(userA.accessToken),
      body: JSON.stringify({ ...validPrefs, pushEnabled: false, clientRequestId: crypto.randomUUID() }),
    });

    const getB = await app.request("/me/notification-preferences", { method: "GET", headers: authHeaders(userB.accessToken) });
    const getBBody = await getB.json();
    expect(getBBody.serverVersion).toBe(0); // Bはまだ未保存（Aの変更の影響を受けない）
    expect(getBBody.pushEnabled).toBe(true); // 仮想デフォルトのまま
  });
});
