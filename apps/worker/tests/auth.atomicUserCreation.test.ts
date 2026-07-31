/**
 * Mobile-G2A-Hardening（残修正）: 新規ユーザー作成のDB原子性。
 * - users/user_identities/初回Refresh Token/監査ログを単一トランザクションで作成する
 * - 途中で失敗した場合、孤立したusers行を残さない
 * - 同一Apple subでの同時初回ログインでも500にならず、両者とも安全に処理される
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { refreshTokens, userIdentities, users } from "../src/db/schema.ts";
import {
  createUserWithAppleIdentityAtomic,
  isUniqueConstraintViolation,
} from "../src/repositories/userRepository.ts";
import { __setAppleJwksResolverForTests } from "../src/auth/apple.ts";
import { __resetRateLimitForTests } from "../src/auth/rateLimit.ts";
import {
  TEST_APPLE_CLIENT_ID,
  createAppleTestKeyPair,
  makeAppleJwksResolver,
  signTestAppleToken,
} from "./helpers/appleTestKit.ts";
import type { KeyLike } from "jose";

const DB_FILE = resolve(process.cwd(), `.tmp-atomic-user-${Date.now()}.db`);

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.INGEST_TOKEN = "test-token";
process.env.ENVIRONMENT = "test";
process.env.APPLE_CLIENT_ID = TEST_APPLE_CLIENT_ID;
process.env.JWT_SIGNING_KEY_CURRENT_KID = "v1";
process.env.JWT_SIGNING_KEY_CURRENT_SECRET = "test-current-secret-not-for-production";
process.env.ACCOUNT_DELETION_GRACE_DAYS = "14";
delete process.env.APPLE_TEAM_ID;
delete process.env.APPLE_KEY_ID;
delete process.env.APPLE_PRIVATE_KEY;
delete process.env.APPLE_TOKEN_ENCRYPTION_KEY;

let app: ReturnType<typeof createApp>;
let identityPrivateKey: KeyLike;
const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  app = createApp(createDb);

  const pair = await createAppleTestKeyPair();
  identityPrivateKey = pair.privateKey;
  __setAppleJwksResolverForTests(makeAppleJwksResolver(pair.publicKey));
});

afterAll(() => {
  __setAppleJwksResolverForTests(undefined);
  rmSync(DB_FILE);
});

describe("createUserWithAppleIdentityAtomic: ロールバック", () => {
  it("users INSERT成功後にuser_identities INSERTが失敗すると、usersも含めて全件ロールバックされる", async () => {
    // 事前に同じsubのidentityを作っておき、2回目の呼び出しでUNIQUE制約違反を起こさせる
    // （= 「usersは新規作成されるがidentityで失敗する」状況を決定的に再現する）。
    await createUserWithAppleIdentityAtomic(db, {
      profile: { sub: "sub-rollback-check" },
      device: { deviceId: "device-seed" },
      audit: {},
    });

    const usersBefore = await db.select().from(users);
    const countBefore = usersBefore.length;

    await expect(
      createUserWithAppleIdentityAtomic(db, {
        profile: { sub: "sub-rollback-check" },
        device: { deviceId: "device-conflict" },
        audit: {},
      })
    ).rejects.toSatisfy((e: unknown) => isUniqueConstraintViolation(e));

    const usersAfter = await db.select().from(users);
    // 新しいusers行が追加されずロールバックされている（件数が増えない）
    expect(usersAfter).toHaveLength(countBefore);

    const identities = await db.select().from(userIdentities).where(eq(userIdentities.providerUserId, "sub-rollback-check"));
    expect(identities).toHaveLength(1); // 最初の1件のみ、2回目の分は残らない

    const conflictDeviceTokens = await db.select().from(refreshTokens).where(eq(refreshTokens.deviceId, "device-conflict"));
    expect(conflictDeviceTokens).toHaveLength(0); // 失敗した試行のRefresh Tokenも残らない
  });

  it("トランザクション内で後続の処理が失敗すると、先に成功していたINSERTも取り消される（一般的な原子性の確認）", async () => {
    const usersBefore = await db.select().from(users);

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(users).values({ publicUserId: crypto.randomUUID() });
        await tx.insert(userIdentities).values({ userId: 999_999_999, provider: "apple", providerUserId: "sub-force-fail-later-step" });
        throw new Error("後続処理（Refresh Token発行相当）の失敗をシミュレート");
      })
    ).rejects.toThrow("後続処理");

    const usersAfter = await db.select().from(users);
    expect(usersAfter).toHaveLength(usersBefore.length);

    const identities = await db.select().from(userIdentities).where(eq(userIdentities.providerUserId, "sub-force-fail-later-step"));
    expect(identities).toHaveLength(0);
  });

  it("isUniqueConstraintViolationは無関係なエラーをtrueと判定しない", () => {
    expect(isUniqueConstraintViolation(new Error("just a normal error"))).toBe(false);
    expect(isUniqueConstraintViolation("not an error object")).toBe(false);
    expect(isUniqueConstraintViolation(null)).toBe(false);
  });
});

describe("同一Apple subの同時初回ログイン（HTTP経由）", () => {
  /**
   * 合格条件（要件どおり）:
   * - usersは1件のみ、user_identitiesは1件のみ（孤立行・重複行が残らない）
   * - どちらのレスポンスも500にならない（unique制約違反等が生の例外として漏れない）
   * - 「両方とも同じpublicUserIdを返す」または「片方だけ成功し、もう片方が安全な
   *   再試行可能エラー（503 SERVICE_BUSY等）になる」のいずれかを満たす
   *
   * 検証時の実測: ローカルのlibSQLファイルクライアントは、同一ファイルへの複数コネクションが
   * 同時にインタラクティブトランザクションを開始すると、PRAGMA busy_timeoutの猶予内でも
   * 解消しないことがある（ローカルファイル特有の制約。Turso本番はクライアント/サーバー型の
   * 別アーキテクチャのため、必ずしも同じ制約を受けない）。このテストは「データが破損しないこと」
   * と「生の500にならないこと」を確定的に検証し、両方が200になるかは実行環境依存として許容する。
   */
  it("usersは1件のみ、user_identitiesは1件のみ、孤立行が残らず、500にならない", async () => {
    __resetRateLimitForTests();
    const sub = "sub-concurrent-first-login";
    const identityToken = await signTestAppleToken({ privateKey: identityPrivateKey, sub });

    const request = (deviceId: string) =>
      app.request("/auth/apple", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identityToken, deviceId }),
      });

    const deviceIds = ["device-concurrent-a", "device-concurrent-b"];
    const [resA, resB] = await Promise.all(deviceIds.map((deviceId) => request(deviceId)));

    // どちらも生の500にならない（unique制約違反やロック競合が未処理のまま漏れない）
    expect(resA.status).not.toBe(500);
    expect(resB.status).not.toBe(500);

    const results = await Promise.all(
      [resA, resB].map(async (res, i) => ({ deviceId: deviceIds[i], status: res.status, body: await res.json() }))
    );
    const successes = results.filter((r) => r.status === 200);
    const failures = results.filter((r) => r.status !== 200);

    // 最大1件だけ成功、というわけではなく「少なくとも1件は成功」しつつ、
    // 失敗する場合は再試行可能な安全なエラー形式であることを確認する。
    expect(successes.length).toBeGreaterThanOrEqual(1);
    for (const failure of failures) {
      // 500（未処理の生の例外）ではなく、code/message/requestIdを備えた整形済みエラーであること
      expect(failure.status).not.toBe(500);
      expect(failure.body.error).toBeDefined();
      expect(failure.body.error.code).toEqual(expect.any(String));
      expect(failure.body.error.requestId).toEqual(expect.any(String));
    }

    // 成功したレスポンスが複数あれば、全て同じpublicUserIdを返す（別ユーザーにならない）
    const publicUserIds = new Set(successes.map((r) => r.body.user.publicUserId));
    expect(publicUserIds.size).toBe(1);

    const [publicUserId] = publicUserIds;
    const userRows = await db.select().from(users).where(eq(users.publicUserId, publicUserId));
    expect(userRows).toHaveLength(1); // 孤立/重複行が残らない

    const identityRows = await db.select().from(userIdentities).where(eq(userIdentities.providerUserId, sub));
    expect(identityRows).toHaveLength(1); // 孤立/重複行が残らない

    // 成功した側のdeviceId分だけ、同じ1人のuserIdに対してRefresh Tokenが存在する（混在しない）
    for (const success of successes) {
      const tokens = await db.select().from(refreshTokens).where(eq(refreshTokens.deviceId, success.deviceId));
      expect(tokens).toHaveLength(1);
      expect(tokens[0].userId).toBe(userRows[0].id);
    }
  });
});
