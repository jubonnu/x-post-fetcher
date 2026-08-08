/**
 * Phase 7: 管理画面（/admin/auth/*）の結合テスト。モバイル向け認証とは完全に別系統。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-admin-auth-${Date.now()}.db`);

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.ADMIN_INVITE_CODE = "test-invite-code";
process.env.ADMIN_JWT_SECRET = "test-admin-jwt-secret-not-for-production";

let app: ReturnType<typeof createApp>;
const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  app = createApp(createDb);
});

afterAll(() => {
  rmSync(DB_FILE);
});

function jsonHeaders() {
  return { "Content-Type": "application/json" };
}

async function signup(email: string, password: string, inviteCode = "test-invite-code") {
  return app.request("/admin/auth/signup", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password, inviteCode }),
  });
}

describe("POST /admin/auth/signup", () => {
  it("正しい招待コードで新規登録でき、トークンが発行される", async () => {
    const res = await signup("admin1@example.com", "password123");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; admin: { email: string } };
    expect(body.token).toBeTruthy();
    expect(body.admin.email).toBe("admin1@example.com");
  });

  it("招待コードが違うと403 FORBIDDEN", async () => {
    const res = await signup("admin2@example.com", "password123", "wrong-code");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("同じメールアドレスで再登録すると409 CONFLICT", async () => {
    await signup("admin3@example.com", "password123");
    const res = await signup("admin3@example.com", "password123");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
  });

  it("パスワードが短すぎると422 VALIDATION_ERROR", async () => {
    const res = await signup("admin4@example.com", "short");
    expect(res.status).toBe(422);
  });

  it("ADMIN_INVITE_CODE未設定なら503 AUTH_NOT_CONFIGURED", async () => {
    const original = process.env.ADMIN_INVITE_CODE;
    delete process.env.ADMIN_INVITE_CODE;
    try {
      const res = await signup("admin5@example.com", "password123");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("AUTH_NOT_CONFIGURED");
    } finally {
      process.env.ADMIN_INVITE_CODE = original;
    }
  });
});

describe("POST /admin/auth/login", () => {
  it("正しいメール・パスワードでログインできる", async () => {
    await signup("login1@example.com", "password123");
    const res = await app.request("/admin/auth/login", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "login1@example.com", password: "password123" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token).toBeTruthy();
  });

  it("パスワードが違うと401 UNAUTHORIZED", async () => {
    await signup("login2@example.com", "password123");
    const res = await app.request("/admin/auth/login", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "login2@example.com", password: "wrong-password" }),
    });
    expect(res.status).toBe(401);
  });

  it("メールアドレスの大文字小文字が違ってもログインできる（大文字小文字を区別しない）", async () => {
    await signup("Case.Test@Example.com", "password123");
    const res = await app.request("/admin/auth/login", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "case.test@example.com", password: "password123" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { admin: { email: string } };
    expect(body.admin.email).toBe("case.test@example.com");
  });

  it("大文字小文字違いのメールアドレスで再登録すると409 CONFLICT（別アカウント扱いにしない）", async () => {
    await signup("dupe.case@example.com", "password123");
    const res = await signup("Dupe.Case@Example.com", "password123");
    expect(res.status).toBe(409);
  });

  it("存在しないメールアドレスでも401 UNAUTHORIZED（列挙攻撃対策）", async () => {
    const res = await app.request("/admin/auth/login", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "does-not-exist@example.com", password: "password123" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/auth/me / POST /admin/auth/change-password", () => {
  async function signupAndGetToken(email: string, password: string): Promise<string> {
    const res = await signup(email, password);
    const body = (await res.json()) as { token: string };
    return body.token;
  }

  it("トークン無しで/admin/auth/meを叩くと401", async () => {
    const res = await app.request("/admin/auth/me");
    expect(res.status).toBe(401);
  });

  it("有効なトークンで自分の情報を取得できる", async () => {
    const token = await signupAndGetToken("me1@example.com", "password123");
    const res = await app.request("/admin/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { admin: { email: string } };
    expect(body.admin.email).toBe("me1@example.com");
  });

  it("現在のパスワードが正しければ変更でき、新パスワードでログインできる", async () => {
    const token = await signupAndGetToken("changepw1@example.com", "password123");
    const changeRes = await app.request("/admin/auth/change-password", {
      method: "POST",
      headers: { ...jsonHeaders(), Authorization: `Bearer ${token}` },
      body: JSON.stringify({ currentPassword: "password123", newPassword: "newpassword456" }),
    });
    expect(changeRes.status).toBe(200);

    const loginRes = await app.request("/admin/auth/login", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "changepw1@example.com", password: "newpassword456" }),
    });
    expect(loginRes.status).toBe(200);

    const oldLoginRes = await app.request("/admin/auth/login", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "changepw1@example.com", password: "password123" }),
    });
    expect(oldLoginRes.status).toBe(401);
  });

  it("現在のパスワードが違えば401", async () => {
    const token = await signupAndGetToken("changepw2@example.com", "password123");
    const res = await app.request("/admin/auth/change-password", {
      method: "POST",
      headers: { ...jsonHeaders(), Authorization: `Bearer ${token}` },
      body: JSON.stringify({ currentPassword: "wrong-password", newPassword: "newpassword456" }),
    });
    expect(res.status).toBe(401);
  });
});
