/**
 * Mobile-G2A-Hardening: Apple authorizationCode交換・失効の結合テスト。
 * APPLE_TEAM_ID等を構成した状態で実際のHonoアプリを通し、Apple本物のAPIへは
 * 一切通信せず（globalThis.fetchをモック）、DBへの反映を確認する。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { exportPKCS8, generateKeyPair } from "jose";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { accountDeletionRequests, userIdentities, users } from "../src/db/schema.ts";
import { __setAppleJwksResolverForTests } from "../src/auth/apple.ts";
import { __resetRateLimitForTests } from "../src/auth/rateLimit.ts";
import { signAccessToken } from "../src/auth/accessToken.ts";
import { createUserWithAppleIdentityAtomic } from "../src/repositories/userRepository.ts";
import {
  TEST_APPLE_CLIENT_ID,
  createAppleTestKeyPair,
  makeAppleJwksResolver,
  signTestAppleToken,
} from "./helpers/appleTestKit.ts";
import type { KeyLike } from "jose";

const DB_FILE = resolve(process.cwd(), `.tmp-apple-revocation-${Date.now()}.db`);

function randomBase64Key(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

let app: ReturnType<typeof createApp>;
let identityPrivateKey: KeyLike;
const dbForAssertions = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
  process.env.INGEST_TOKEN = "test-token";
  process.env.ENVIRONMENT = "test";
  process.env.APPLE_CLIENT_ID = TEST_APPLE_CLIENT_ID;
  process.env.JWT_SIGNING_KEY_CURRENT_KID = "v1";
  process.env.JWT_SIGNING_KEY_CURRENT_SECRET = "test-current-secret-not-for-production";
  process.env.ACCOUNT_DELETION_GRACE_DAYS = "14";

  // Apple token交換機能を有効化するための設定（正式な.p8鍵は無いためテスト用に生成）
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  process.env.APPLE_TEAM_ID = "TEAMTEST01";
  process.env.APPLE_KEY_ID = "KEYTEST01";
  process.env.APPLE_PRIVATE_KEY = await exportPKCS8(privateKey);
  process.env.APPLE_TOKEN_ENCRYPTION_KEY = randomBase64Key();
  process.env.APPLE_TOKEN_ENCRYPTION_KEY_VERSION = "v1";

  const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });
  await migrate(db, { migrationsFolder: "./migrations" });
  app = createApp(createDb);

  const pair = await createAppleTestKeyPair();
  identityPrivateKey = pair.privateKey;
  __setAppleJwksResolverForTests(makeAppleJwksResolver(pair.publicKey));
});

afterEach(() => {
  __resetRateLimitForTests();
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  __setAppleJwksResolverForTests(undefined);
  rmSync(DB_FILE);
  delete process.env.APPLE_TEAM_ID;
  delete process.env.APPLE_KEY_ID;
  delete process.env.APPLE_PRIVATE_KEY;
  delete process.env.APPLE_TOKEN_ENCRYPTION_KEY;
  delete process.env.APPLE_TOKEN_ENCRYPTION_KEY_VERSION;
});

async function loginWithAuthorizationCode(sub: string, deviceId: string) {
  const identityToken = await signTestAppleToken({ privateKey: identityPrivateKey, sub });
  const res = await app.request("/auth/apple", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identityToken, authorizationCode: "mock-authorization-code", deviceId }),
  });
  return { res, body: await res.json() };
}

describe("Apple authorizationCode交換（ログイン時）", () => {
  it("交換に成功すると暗号化されたApple Refresh Tokenがuser_identitiesへ保存される", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/auth/token")) {
        return new Response(JSON.stringify({ refresh_token: "mock-apple-refresh-token-1", expires_in: 3600 }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { res } = await loginWithAuthorizationCode("sub-exchange-success", "device-ex1");
    expect(res.status).toBe(200);

    const rows = await dbForAssertions.select().from(userIdentities).where(eq(userIdentities.providerUserId, "sub-exchange-success"));
    expect(rows[0].appleRefreshTokenCiphertext).toEqual(expect.any(String));
    expect(rows[0].appleRefreshTokenCiphertext).not.toContain("mock-apple-refresh-token-1");
    expect(rows[0].appleRefreshTokenKeyVersion).toBe("v1");
  });

  it("新規ユーザーで交換に失敗した場合、ログインを拒否し(503 AUTH_PROVIDER_UNAVAILABLE)、users/user_identitiesに行を残さない", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;

    const { res, body } = await loginWithAuthorizationCode("sub-exchange-fail", "device-ex2");
    expect(res.status).toBe(503);
    expect(body.error.code).toBe("AUTH_PROVIDER_UNAVAILABLE");

    const identityRows = await dbForAssertions.select().from(userIdentities).where(eq(userIdentities.providerUserId, "sub-exchange-fail"));
    expect(identityRows).toHaveLength(0);
  });

  it("新規ユーザーでauthorizationCodeが無い場合、422 VALIDATION_ERRORになる", async () => {
    const identityToken = await signTestAppleToken({ privateKey: identityPrivateKey, sub: "sub-no-code" });
    const res = await app.request("/auth/apple", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identityToken, deviceId: "device-no-code" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");

    const identityRows = await dbForAssertions.select().from(userIdentities).where(eq(userIdentities.providerUserId, "sub-no-code"));
    expect(identityRows).toHaveLength(0);
  });

  it("新規ユーザーで暗号化保存(交換自体は成功)に相当する異常時もuserを作成しない: 交換結果が不正な場合", async () => {
    // refresh_tokenを含まないApple応答は交換失敗として扱われる（exchangeAppleAuthorizationCodeの仕様通り）
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;

    const { res } = await loginWithAuthorizationCode("sub-exchange-malformed", "device-ex3");
    expect(res.status).toBe(503);

    const userRows = await dbForAssertions.select().from(userIdentities).where(eq(userIdentities.providerUserId, "sub-exchange-malformed"));
    expect(userRows).toHaveLength(0);
  });

  it("production/previewでApple token交換設定が不足していれば503 AUTH_NOT_CONFIGUREDになる", async () => {
    const savedTeamId = process.env.APPLE_TEAM_ID;
    delete process.env.APPLE_TEAM_ID;
    process.env.ENVIRONMENT = "production";

    try {
      const identityToken = await signTestAppleToken({ privateKey: identityPrivateKey, sub: "sub-prod-unconfigured" });
      const res = await app.request("/auth/apple", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identityToken, authorizationCode: "code", deviceId: "device-prod1" }),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.code).toBe("AUTH_NOT_CONFIGURED");
    } finally {
      process.env.ENVIRONMENT = "test";
      process.env.APPLE_TEAM_ID = savedTeamId;
    }
  });
});

describe("既存ユーザーの再ログイン", () => {
  it("保存済みトークンがあれば、今回の交換が失敗してもログインを継続する", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/auth/token")) {
        return new Response(JSON.stringify({ refresh_token: "mock-apple-refresh-token-initial", expires_in: 3600 }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const first = await loginWithAuthorizationCode("sub-relogin-fallback", "device-relogin-1");
    expect(first.res.status).toBe(200);

    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;

    const second = await loginWithAuthorizationCode("sub-relogin-fallback", "device-relogin-2");
    expect(second.res.status).toBe(200);
    expect(second.body.user.publicUserId).toBe(first.body.user.publicUserId);
  });

  it("保存済みトークンが無く、今回の交換も失敗すれば拒否する", async () => {
    // 交換が一度も成功していないユーザーをApple連携導入前のレガシーデータとして再現する。
    const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });
    await createUserWithAppleIdentityAtomic(db, {
      profile: { sub: "sub-relogin-no-fallback" },
      device: { deviceId: "seed-device-relogin-no-fallback" },
      audit: {},
    });

    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;

    const { res, body } = await loginWithAuthorizationCode("sub-relogin-no-fallback", "device-relogin-3");
    expect(res.status).toBe(503);
    expect(body.error.code).toBe("AUTH_PROVIDER_UNAVAILABLE");
  });

  it("Appleが新しいRefresh Tokenを返した場合、保存内容が更新される", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ refresh_token: "mock-token-v1", expires_in: 3600 }), { status: 200 })) as typeof fetch;
    const first = await loginWithAuthorizationCode("sub-relogin-update", "device-relogin-4");
    expect(first.res.status).toBe(200);

    const beforeRows = await dbForAssertions.select().from(userIdentities).where(eq(userIdentities.providerUserId, "sub-relogin-update"));
    const beforeCiphertext = beforeRows[0].appleRefreshTokenCiphertext;

    globalThis.fetch = (async () => new Response(JSON.stringify({ refresh_token: "mock-token-v2-updated", expires_in: 3600 }), { status: 200 })) as typeof fetch;
    const second = await loginWithAuthorizationCode("sub-relogin-update", "device-relogin-5");
    expect(second.res.status).toBe(200);

    const afterRows = await dbForAssertions.select().from(userIdentities).where(eq(userIdentities.providerUserId, "sub-relogin-update"));
    expect(afterRows[0].appleRefreshTokenCiphertext).not.toBe(beforeCiphertext);
  });
});

describe("Apple側トークン失効（アカウント削除時）", () => {
  it("Apple Refresh Tokenが無いユーザーの削除はnot_applicableになり、削除自体は成功する", async () => {
    // 新規ユーザー作成が交換成功を必須とする現行仕様のもとでは、ログインAPI経由では
    // 「Apple Refresh Tokenを持たないユーザー」を作れない。ここではApple連携導入前の
    // 既存ユーザー（レガシーデータ）を模して、リポジトリ関数で直接そのようなユーザーを作成し、
    // アクセストークンを手動発行してDELETE /meのみを検証する。
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/auth/revoke")) {
        throw new Error("Apple Refresh Tokenが無いはずなのにrevokeへ通信された");
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });
    const { user } = await createUserWithAppleIdentityAtomic(db, {
      profile: { sub: "sub-no-token" },
      device: { deviceId: "seed-device-no-token" },
      audit: {},
    });
    const accessToken = await signAccessToken({
      publicUserId: user.publicUserId,
      signingKeys: { current: { kid: "v1", secret: "test-current-secret-not-for-production" } },
    });

    const res = await app.request("/me", { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
    expect(res.status).toBe(200);

    const rows = await dbForAssertions.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, user.id));
    expect(rows[0].appleRevocationStatus).toBe("not_applicable");
  });

  it("失効に成功するとsucceededになり、削除は成功する", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/auth/token")) {
        return new Response(JSON.stringify({ refresh_token: "mock-apple-refresh-token-2", expires_in: 3600 }), { status: 200 });
      }
      if (String(url).includes("/auth/revoke")) {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const login = await loginWithAuthorizationCode("sub-revoke-success", "device-del2");
    const res = await app.request("/me", { method: "DELETE", headers: { Authorization: `Bearer ${login.body.accessToken}` } });
    expect(res.status).toBe(200);

    const rows = await dbForAssertions.select().from(accountDeletionRequests);
    const latest = rows[rows.length - 1];
    expect(latest.appleRevocationStatus).toBe("succeeded");
  });

  it("失効に失敗してもアカウント削除自体は成功し、failed_will_retryとして記録される", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/auth/token")) {
        return new Response(JSON.stringify({ refresh_token: "mock-apple-refresh-token-3", expires_in: 3600 }), { status: 200 });
      }
      if (String(url).includes("/auth/revoke")) {
        return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const login = await loginWithAuthorizationCode("sub-revoke-fail", "device-del3");
    const res = await app.request("/me", { method: "DELETE", headers: { Authorization: `Bearer ${login.body.accessToken}` } });
    expect(res.status).toBe(200);

    const rows = await dbForAssertions.select().from(accountDeletionRequests);
    const latest = rows[rows.length - 1];
    expect(latest.appleRevocationStatus).toBe("failed_will_retry");
    expect(latest.appleRevocationAttempts).toBe(1);
    // エラー内容にトークンの生値が含まれない
    expect(latest.appleRevocationLastError ?? "").not.toContain("mock-apple-refresh-token-3");
  });

  it("同じ削除要求の再送は冪等で、失敗していた失効を再試行する", async () => {
    let revokeCallCount = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/auth/token")) {
        return new Response(JSON.stringify({ refresh_token: "mock-apple-refresh-token-4", expires_in: 3600 }), { status: 200 });
      }
      if (String(url).includes("/auth/revoke")) {
        revokeCallCount += 1;
        if (revokeCallCount === 1) {
          return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
        }
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const login = await loginWithAuthorizationCode("sub-revoke-retry", "device-del4");
    const first = await app.request("/me", { method: "DELETE", headers: { Authorization: `Bearer ${login.body.accessToken}` } });
    expect(first.status).toBe(200);

    const second = await app.request("/me", { method: "DELETE", headers: { Authorization: `Bearer ${login.body.accessToken}` } });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect((await first.json()).scheduledDeletionAt).toBe(secondBody.scheduledDeletionAt);

    expect(revokeCallCount).toBe(2);
    const rows = await dbForAssertions.select().from(accountDeletionRequests);
    const latest = rows[rows.length - 1];
    expect(latest.appleRevocationStatus).toBe("succeeded");
  });
});
