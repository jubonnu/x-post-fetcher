/**
 * Mobile-G2A: 認証APIの結合テスト（Sign in with Apple → Access/Refresh Token → /me → logout → 削除要求）。
 * ローカルTursoファイルDBに対して実際のHonoアプリ（app.request）を通して検証する。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { auditLogs } from "../src/db/schema.ts";
import { __setAppleJwksResolverForTests } from "../src/auth/apple.ts";
import { __resetRateLimitForTests } from "../src/auth/rateLimit.ts";
import {
  TEST_APPLE_CLIENT_ID,
  createAppleTestKeyPair,
  makeAppleJwksResolver,
  signTestAppleToken,
  type SignTestAppleTokenOptions,
} from "./helpers/appleTestKit.ts";
import type { KeyLike } from "jose";

const DB_FILE = resolve(process.cwd(), `.tmp-auth-flow-${Date.now()}.db`);

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

const dbForAssertions = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });

beforeAll(async () => {
  const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });
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
  deviceId = "device-1",
  extra: { fullName?: string } = {}
) {
  const identityToken = await signTestAppleToken({ privateKey, ...overrides });
  const res = await app.request("/auth/apple", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identityToken, deviceId, ...extra }),
  });
  const body = await res.json();
  return { res, body };
}

describe("POST /auth/apple", () => {
  it("新規ユーザーを作成しAccess/Refresh Tokenを発行する", async () => {
    const { res, body } = await loginWithApple({ sub: "sub-new-user-1", email: "new1@example.com" }, "device-a");
    expect(res.status).toBe(200);
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
    expect(body.expiresIn).toBe(15 * 60);
    expect(body.user.email).toBe("new1@example.com");
    expect(body.user).not.toHaveProperty("id");
  });

  it("同じApple subで再ログインすると同じユーザー（同じpublicUserId）を返す", async () => {
    const first = await loginWithApple({ sub: "sub-repeat-user", email: "repeat@example.com" }, "device-b");
    const second = await loginWithApple({ sub: "sub-repeat-user", email: "repeat@example.com" }, "device-c");
    expect(second.body.user.publicUserId).toBe(first.body.user.publicUserId);
  });

  it("emailがnullの再ログインで既存emailを消さない", async () => {
    const first = await loginWithApple({ sub: "sub-email-keep", email: "keep@example.com" }, "device-d");
    expect(first.body.user.email).toBe("keep@example.com");

    const second = await loginWithApple({ sub: "sub-email-keep", email: undefined }, "device-e");
    expect(second.body.user.publicUserId).toBe(first.body.user.publicUserId);
    expect(second.body.user.email).toBe("keep@example.com");
  });

  it("不正なidentityTokenは401", async () => {
    const res = await app.request("/auth/apple", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identityToken: "not-a-jwt", deviceId: "device-x" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.requestId).toEqual(expect.any(String));
  });

  it("リクエスト形式が不正な場合は422", async () => {
    const res = await app.request("/auth/apple", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("初回サインイン時にfullNameを送るとdisplayNameとして保存される", async () => {
    const { body } = await loginWithApple({ sub: "sub-display-name-1", email: "dn1@example.com" }, "device-dn-1", {
      fullName: "安田潤",
    });
    expect(body.user.displayName).toBe("安田潤");
  });

  it("fullName無しの初回サインインではdisplayNameはnullのまま", async () => {
    const { body } = await loginWithApple({ sub: "sub-display-name-2", email: "dn2@example.com" }, "device-dn-2");
    expect(body.user.displayName).toBeNull();
  });

  it("ログアウト後の再ログイン相当（fullName無し）でも、既に保存済みのdisplayNameは維持される", async () => {
    const first = await loginWithApple({ sub: "sub-display-name-3", email: "dn3@example.com" }, "device-dn-3a", {
      fullName: "安田潤",
    });
    expect(first.body.user.displayName).toBe("安田潤");

    // 2回目はAppleがfullNameを送ってこない（標準的な挙動）。
    const second = await loginWithApple({ sub: "sub-display-name-3", email: "dn3@example.com" }, "device-dn-3b");
    expect(second.body.user.publicUserId).toBe(first.body.user.publicUserId);
    expect(second.body.user.displayName).toBe("安田潤");
  });

  it("displayName未設定のユーザーが後からfullName付きで再ログインすると保存される（Apple ID連携リセット相当）", async () => {
    const first = await loginWithApple({ sub: "sub-display-name-4", email: "dn4@example.com" }, "device-dn-4a");
    expect(first.body.user.displayName).toBeNull();

    const second = await loginWithApple({ sub: "sub-display-name-4", email: "dn4@example.com" }, "device-dn-4b", {
      fullName: "田中太郎",
    });
    expect(second.body.user.displayName).toBe("田中太郎");
  });

  it("既にdisplayNameが保存済みの場合、別のfullNameが送られても上書きしない", async () => {
    const first = await loginWithApple({ sub: "sub-display-name-5", email: "dn5@example.com" }, "device-dn-5a", {
      fullName: "最初の名前",
    });
    expect(first.body.user.displayName).toBe("最初の名前");

    const second = await loginWithApple({ sub: "sub-display-name-5", email: "dn5@example.com" }, "device-dn-5b", {
      fullName: "別の名前",
    });
    expect(second.body.user.displayName).toBe("最初の名前"); // 上書きされない
  });
});

describe("認可（GET /me）", () => {
  it("Authorizationヘッダなしは401", async () => {
    const res = await app.request("/me", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("不正な署名のAccess Tokenは401", async () => {
    const { body } = await loginWithApple({ sub: "sub-authz-1" }, "device-f");
    const tampered = body.accessToken.slice(0, -2) + "zz";
    const res = await app.request("/me", { method: "GET", headers: { Authorization: `Bearer ${tampered}` } });
    expect(res.status).toBe(401);
  });

  it("正常なAccess TokenでGET /meが成功する", async () => {
    const { body } = await loginWithApple({ sub: "sub-authz-2", email: "authz2@example.com" }, "device-g");
    const res = await app.request("/me", { method: "GET", headers: { Authorization: `Bearer ${body.accessToken}` } });
    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me.email).toBe("authz2@example.com");
    expect(me.accountStatus).toBe("active");
    expect(me).not.toHaveProperty("id");
  });

  it("別ユーザーのAccess Tokenでは自分自身のデータしか見えない（IDOR対策）", async () => {
    const userA = await loginWithApple({ sub: "sub-idor-a" }, "device-h");
    const userB = await loginWithApple({ sub: "sub-idor-b" }, "device-i");

    const resA = await app.request("/me", { method: "GET", headers: { Authorization: `Bearer ${userA.body.accessToken}` } });
    const resB = await app.request("/me", { method: "GET", headers: { Authorization: `Bearer ${userB.body.accessToken}` } });
    const meA = await resA.json();
    const meB = await resB.json();

    expect(meA.publicUserId).toBe(userA.body.user.publicUserId);
    expect(meB.publicUserId).toBe(userB.body.user.publicUserId);
    expect(meA.publicUserId).not.toBe(meB.publicUserId);
  });
});

describe("POST /auth/refresh", () => {
  it("正常にローテーションできる（新しいトークンが返り、旧トークンは無効になる）", async () => {
    const login = await loginWithApple({ sub: "sub-refresh-1" }, "device-j");
    const res = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: login.body.refreshToken, deviceId: "device-j" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).not.toBe(login.body.refreshToken);

    // 旧Refresh Tokenの再送は再利用検知（reuse detected）扱いになる
    const reuseRes = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: login.body.refreshToken, deviceId: "device-j" }),
    });
    expect(reuseRes.status).toBe(401);
  });

  it("再利用検知時は同一ユーザーの全Refresh Tokenが失効する", async () => {
    const login = await loginWithApple({ sub: "sub-refresh-reuse" }, "device-k");
    const rotated = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: login.body.refreshToken, deviceId: "device-k" }),
    });
    const rotatedBody = await rotated.json();

    // 再利用検知の猶予期間（正常な同時リクエストとの区別用）を過ぎてから旧トークンを再送する
    // ことで、「競合」ではなく本物の再利用であることを明確にする。
    await new Promise((r) => setTimeout(r, 1100));

    // 旧トークンを再送 → 再利用検知
    await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: login.body.refreshToken, deviceId: "device-k" }),
    });

    // ローテーションで得たはずの新トークンも、再利用検知の全失効で無効になっている
    const res = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: rotatedBody.refreshToken, deviceId: "device-k" }),
    });
    expect(res.status).toBe(401);
  });

  it("deviceIdが一致しないトークンは拒否される", async () => {
    const login = await loginWithApple({ sub: "sub-refresh-device" }, "device-l");
    const res = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: login.body.refreshToken, deviceId: "device-different" }),
    });
    expect(res.status).toBe(401);
  });

  it("同一の有効Refresh Tokenへほぼ同時に2リクエストが来た場合、最大1件だけ成功し、他デバイスは巻き込まれない", async () => {
    const target = await loginWithApple({ sub: "sub-concurrent-same-token" }, "device-race");
    const otherDevice = await loginWithApple({ sub: "sub-concurrent-same-token" }, "device-race-other");

    const request = () =>
      app.request("/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: target.body.refreshToken, deviceId: "device-race" }),
      });

    const [resA, resB] = await Promise.all([request(), request()]);
    const statuses = [resA.status, resB.status].sort();

    // 最大1件だけ成功（200）、もう1件は401（正常な競合、盗難再利用としては扱わない）
    expect(statuses).toEqual([200, 401]);

    const winner = resA.status === 200 ? resA : resB;
    const winnerBody = await winner.json();

    // 勝者が得た新しいRefresh Tokenは引き続き使用できる
    const followUp = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: winnerBody.refreshToken, deviceId: "device-race" }),
    });
    expect(followUp.status).toBe(200);

    // 正常な競合であり、盗難再利用とは誤判定されないため、他デバイス（同一ユーザーの別セッション）は
    // 全端末ログアウト相当の巻き込みを受けず、引き続き使用できる
    const otherStillWorks = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: otherDevice.body.refreshToken, deviceId: "device-race-other" }),
    });
    expect(otherStillWorks.status).toBe(200);
  });

  it("不正なRefresh Tokenは401", async () => {
    const res = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: "totally-invalid-token-value", deviceId: "device-m" }),
    });
    expect(res.status).toBe(401);
  });

  it("同時に複数端末でRefresh Tokenをローテーションしても、それぞれ独立して成功する", async () => {
    const loginX = await loginWithApple({ sub: "sub-concurrent" }, "device-x1");
    const loginY = await loginWithApple({ sub: "sub-concurrent" }, "device-x2");

    const [resX, resY] = await Promise.all([
      app.request("/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: loginX.body.refreshToken, deviceId: "device-x1" }),
      }),
      app.request("/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: loginY.body.refreshToken, deviceId: "device-x2" }),
      }),
    ]);

    expect(resX.status).toBe(200);
    expect(resY.status).toBe(200);
  });
});

describe("ログアウト・削除", () => {
  it("logoutは冪等（複数回呼んでもok:true）", async () => {
    const login = await loginWithApple({ sub: "sub-logout-1" }, "device-n");
    const first = await app.request("/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${login.body.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: "device-n" }),
    });
    const second = await app.request("/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${login.body.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: "device-n" }),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // ログアウト済みdeviceのRefresh Tokenはもう使えない
    const refreshRes = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: login.body.refreshToken, deviceId: "device-n" }),
    });
    expect(refreshRes.status).toBe(401);
  });

  it("logoutで失効した(rotated以外の)トークンの再送は、他デバイスを巻き込む再利用検知を発火させない", async () => {
    const other = await loginWithApple({ sub: "sub-logout-not-reuse" }, "device-other");
    const target = await loginWithApple({ sub: "sub-logout-not-reuse" }, "device-r");

    await app.request("/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${target.body.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: "device-r" }),
    });

    // ログアウト済みトークンの再送は拒否されるが、
    const reuseAttempt = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: target.body.refreshToken, deviceId: "device-r" }),
    });
    expect(reuseAttempt.status).toBe(401);

    // 別デバイス(other)のセッションは巻き込まれず生きている
    const otherRefresh = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: other.body.refreshToken, deviceId: "device-other" }),
    });
    expect(otherRefresh.status).toBe(200);
  });

  it("logout-allは全端末のRefresh Tokenを失効させる", async () => {
    const loginA = await loginWithApple({ sub: "sub-logout-all" }, "device-o1");
    const loginB = await loginWithApple({ sub: "sub-logout-all" }, "device-o2");

    const res = await app.request("/auth/logout-all", {
      method: "POST",
      headers: { Authorization: `Bearer ${loginA.body.accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revokedCount).toBeGreaterThanOrEqual(2);

    const refreshA = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: loginA.body.refreshToken, deviceId: "device-o1" }),
    });
    const refreshB = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: loginB.body.refreshToken, deviceId: "device-o2" }),
    });
    expect(refreshA.status).toBe(401);
    expect(refreshB.status).toBe(401);
  });

  it("DELETE /meはpending_deletionへ遷移し、冪等で、全Refresh Tokenを失効させる", async () => {
    const login = await loginWithApple({ sub: "sub-delete-1" }, "device-p");

    const first = await app.request("/me", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${login.body.accessToken}` },
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.scheduledDeletionAt).toEqual(expect.any(String));

    const second = await app.request("/me", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${login.body.accessToken}` },
    });
    const secondBody = await second.json();
    expect(second.status).toBe(200);
    expect(secondBody.scheduledDeletionAt).toBe(firstBody.scheduledDeletionAt);

    // アクセストークン自体はまだ有効期限内なのでGET /meは通るが、accountStatusがpending_deletionになっている
    const meRes = await app.request("/me", { method: "GET", headers: { Authorization: `Bearer ${login.body.accessToken}` } });
    const me = await meRes.json();
    expect(me.accountStatus).toBe("pending_deletion");

    // 削除要求と同時に全Refresh Tokenが失効している
    const refreshRes = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: login.body.refreshToken, deviceId: "device-p" }),
    });
    expect(refreshRes.status).toBe(401);
  });

  it("audit_logsに生のトークンが記録されない", async () => {
    const login = await loginWithApple({ sub: "sub-audit-1" }, "device-q");

    const rows = await dbForAssertions.select().from(auditLogs).where(eq(auditLogs.action, "login"));
    const relevant = rows.filter((r) => r.detailJson?.includes("device-q"));
    expect(relevant.length).toBeGreaterThan(0);
    for (const row of relevant) {
      expect(row.detailJson ?? "").not.toContain(login.body.accessToken);
      expect(row.detailJson ?? "").not.toContain(login.body.refreshToken);
    }
  });
});
