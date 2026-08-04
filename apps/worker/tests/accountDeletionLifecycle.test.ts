/**
 * Mobile-G2A残修正: アカウント削除の猶予期間フロー全体（`DELETE /me` → 再サインインでの取消 →
 * 猶予期間経過後の物理削除バッチ）を結合テストで検証する。
 * アプリ内の案内文「〇月〇日に削除されます。それまでは再度サインインすると取り消せます」の
 * 実装が伴っていることと、Apple側トークン失効の再試行が取消済み要求を巻き込まないことを確認する。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { and, eq } from "drizzle-orm";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import {
  accountDeletionRequests,
  auditLogs,
  notificationPreferences,
  refreshTokens,
  userIdentities,
  userLotteries,
  users,
} from "../src/db/schema.ts";
import { __setAppleJwksResolverForTests } from "../src/auth/apple.ts";
import { __resetRateLimitForTests } from "../src/auth/rateLimit.ts";
import { findAppleRevocationRetryTargets } from "../src/repositories/appleRevocationRetryRepository.ts";
import { runAccountHardDeletionBatch } from "../src/services/accountHardDeletionService.ts";
import {
  TEST_APPLE_CLIENT_ID,
  createAppleTestKeyPair,
  makeAppleJwksResolver,
  signTestAppleToken,
  type SignTestAppleTokenOptions,
} from "./helpers/appleTestKit.ts";
import type { KeyLike } from "jose";

const DB_FILE = resolve(process.cwd(), `.tmp-account-deletion-lifecycle-${Date.now()}.db`);

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.INGEST_TOKEN = "test-token";
process.env.APPLE_CLIENT_ID = TEST_APPLE_CLIENT_ID;
process.env.JWT_SIGNING_KEY_CURRENT_KID = "v1";
process.env.JWT_SIGNING_KEY_CURRENT_SECRET = "test-current-secret-not-for-production";
delete process.env.JWT_SIGNING_KEY_PREVIOUS_KID;
delete process.env.JWT_SIGNING_KEY_PREVIOUS_SECRET;
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

afterEach(() => {
  __resetRateLimitForTests();
});

afterAll(() => {
  __setAppleJwksResolverForTests(undefined);
  rmSync(DB_FILE);
});

async function loginWithApple(
  overrides: Partial<Omit<SignTestAppleTokenOptions, "privateKey">> = {},
  deviceId = "device-1"
) {
  const identityToken = await signTestAppleToken({ privateKey, ...overrides });
  const res = await app.request("/auth/apple", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identityToken, deviceId }),
  });
  const body = await res.json();
  return { res, body };
}

async function internalUserIdFor(publicUserId: string): Promise<number> {
  const [row] = await db.select().from(users).where(eq(users.publicUserId, publicUserId));
  if (!row) throw new Error("user not found");
  return row.id;
}

describe("再サインインによる削除取消", () => {
  it("DELETE /me後に再サインインするとpending_deletionが取り消され、accountStatusがactiveへ戻る", async () => {
    const login = await loginWithApple({ sub: "sub-cancel-1" }, "device-cancel-1a");

    const del = await app.request("/me", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${login.body.accessToken}` },
    });
    expect(del.status).toBe(200);
    const delBody = await del.json();

    const userId = await internalUserIdFor(login.body.user.publicUserId);
    const [beforeRow] = await db
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.userId, userId));
    expect(beforeRow.status).toBe("pending");

    // 全端末サインアウト済みなので、新しいSign in with Appleフローで再サインインする。
    const relogin = await loginWithApple({ sub: "sub-cancel-1" }, "device-cancel-1b");
    expect(relogin.res.status).toBe(200);
    expect(relogin.body.user.publicUserId).toBe(login.body.user.publicUserId);
    expect(relogin.body.user.accountStatus).toBe("active");

    const meRes = await app.request("/me", {
      method: "GET",
      headers: { Authorization: `Bearer ${relogin.body.accessToken}` },
    });
    const me = await meRes.json();
    expect(me.accountStatus).toBe("active");
    expect(me.scheduledDeletionAt).toBeNull();

    const [afterRow] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, beforeRow.id));
    expect(afterRow.status).toBe("cancelled");
    expect(afterRow.cancelledAt).toEqual(expect.any(String));

    const cancelLogs = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.userId, userId), eq(auditLogs.action, "account_deletion_cancelled")));
    expect(cancelLogs.length).toBe(1);

    // 取消後に再度削除要求すると、キャンセル済みの古い行は再利用されず新しい行が作られる。
    const redelete = await app.request("/me", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${relogin.body.accessToken}` },
    });
    const redeleteBody = await redelete.json();
    expect(redeleteBody.scheduledDeletionAt).not.toBe(delBody.scheduledDeletionAt);
  });

  it("取り消し済みの削除要求は、appleRevocationStatusがfailed_will_retryのままでもCron再試行対象に含まれない", async () => {
    const login = await loginWithApple({ sub: "sub-cancel-2" }, "device-cancel-2a");
    await app.request("/me", { method: "DELETE", headers: { Authorization: `Bearer ${login.body.accessToken}` } });

    const userId = await internalUserIdFor(login.body.user.publicUserId);
    const [row] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, userId));

    // Apple側失効が一時的に失敗した状態を模す（本来はCronが記録する）。
    await db
      .update(accountDeletionRequests)
      .set({ appleRevocationStatus: "failed_will_retry", appleRevocationNextRetryAt: new Date(0).toISOString() })
      .where(eq(accountDeletionRequests.id, row.id));

    const targetsBeforeCancel = await findAppleRevocationRetryTargets(db, {});
    expect(targetsBeforeCancel.map((t) => t.id)).toContain(row.id);

    await loginWithApple({ sub: "sub-cancel-2" }, "device-cancel-2b");

    const targetsAfterCancel = await findAppleRevocationRetryTargets(db, {});
    expect(targetsAfterCancel.map((t) => t.id)).not.toContain(row.id);
  });
});

describe("猶予期間経過後の物理削除バッチ", () => {
  it("scheduledDeletionAtを過ぎたアカウントを物理削除し、PII/認証情報を消去してaccountStatusをdeletedにする", async () => {
    const login = await loginWithApple({ sub: "sub-harddelete-1", email: "harddelete1@example.com" }, "device-hd-1");
    const userId = await internalUserIdFor(login.body.user.publicUserId);

    // ユーザー保有データがある状態を再現する（ソフトデリートに揃えられることを確認するため）。
    await db.insert(userLotteries).values({
      userId,
      lotteryId: 1,
      status: "planned",
      savedAt: new Date().toISOString(),
    });

    await app.request("/me", { method: "DELETE", headers: { Authorization: `Bearer ${login.body.accessToken}` } });

    // 猶予期間経過を模すため、scheduledDeletionAtを過去に書き換える（14日待つ代わり）。
    await db
      .update(accountDeletionRequests)
      .set({ scheduledDeletionAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(accountDeletionRequests.userId, userId));

    const result = await runAccountHardDeletionBatch({ db, limit: 50 });
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const [requestRow] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, userId));
    expect(requestRow.status).toBe("completed");
    expect(requestRow.completedAt).toEqual(expect.any(String));

    const [userRow] = await db.select().from(users).where(eq(users.id, userId));
    expect(userRow.accountStatus).toBe("deleted");
    expect(userRow.email).toBeNull();
    expect(userRow.displayName).toBeNull();
    expect(userRow.deletedAt).toEqual(expect.any(String));

    const identities = await db.select().from(userIdentities).where(eq(userIdentities.userId, userId));
    expect(identities.length).toBe(0);

    const tokens = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId));
    expect(tokens.length).toBe(0);

    const lotteries = await db.select().from(userLotteries).where(eq(userLotteries.userId, userId));
    expect(lotteries.length).toBe(1);
    expect(lotteries[0].deletedAt).toEqual(expect.any(String));

    const completedLogs = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.userId, userId), eq(auditLogs.action, "account_deletion_completed")));
    expect(completedLogs.length).toBe(1);

    // 同じApple subで再サインインすると、identityが消えているため新規ユーザーとして作成される。
    const relogin = await loginWithApple({ sub: "sub-harddelete-1", email: "harddelete1@example.com" }, "device-hd-2");
    expect(relogin.res.status).toBe(200);
    expect(relogin.body.user.publicUserId).not.toBe(login.body.user.publicUserId);
    expect(relogin.body.user.accountStatus).toBe("active");
  });

  it("猶予期間内（scheduledDeletionAtが未来）のアカウントはバッチ対象にならない", async () => {
    const login = await loginWithApple({ sub: "sub-harddelete-2" }, "device-hd-3");
    await app.request("/me", { method: "DELETE", headers: { Authorization: `Bearer ${login.body.accessToken}` } });
    const userId = await internalUserIdFor(login.body.user.publicUserId);

    await runAccountHardDeletionBatch({ db, limit: 50 });

    const [userRow] = await db.select().from(users).where(eq(users.id, userId));
    expect(userRow.accountStatus).toBe("pending_deletion");
  });

  it("通知設定を持つユーザーの物理削除で例外が起きない（1ユーザー1行テーブルの網羅確認）", async () => {
    const login = await loginWithApple({ sub: "sub-harddelete-3" }, "device-hd-4");
    const userId = await internalUserIdFor(login.body.user.publicUserId);

    await db.insert(notificationPreferences).values({
      userId,
      deadlineReminder: true,
      announcementReminder: true,
      purchaseReminder: true,
      newLotteryAlert: true,
      favoriteUpdateAlert: true,
      pushEnabled: true,
      emailEnabled: true,
      quietHoursEnabled: false,
      deadlineReminderHoursBefore: 24,
      announcementReminderHoursBefore: 24,
      purchaseReminderHoursBefore: 24,
    });

    await app.request("/me", { method: "DELETE", headers: { Authorization: `Bearer ${login.body.accessToken}` } });
    await db
      .update(accountDeletionRequests)
      .set({ scheduledDeletionAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(accountDeletionRequests.userId, userId));

    const result = await runAccountHardDeletionBatch({ db, limit: 50 });
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const prefs = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
    expect(prefs.length).toBe(0);
  });
});
