/**
 * Mobile-G2A-Hardening: 認証設定が未構成/不正な場合、認証ルートのみ503にし、
 * 公開GET API（/lotteries）は稼働を維持することの確認。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-auth-notconfigured-${Date.now()}.db`);

const AUTH_ENV_KEYS = [
  "ENVIRONMENT",
  "APPLE_CLIENT_ID",
  "JWT_SIGNING_KEY_CURRENT_KID",
  "JWT_SIGNING_KEY_CURRENT_SECRET",
  "JWT_SIGNING_KEY_PREVIOUS_KID",
  "JWT_SIGNING_KEY_PREVIOUS_SECRET",
  "ACCOUNT_DELETION_GRACE_DAYS",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  savedEnv = Object.fromEntries(AUTH_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of AUTH_ENV_KEYS) delete process.env[k];

  process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
  process.env.INGEST_TOKEN = "test-token";

  const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });
  await migrate(db, { migrationsFolder: "./migrations" });
  app = createApp(createDb);
});

afterAll(() => {
  for (const k of AUTH_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(DB_FILE);
});

describe("認証設定が未構成の場合", () => {
  it("POST /auth/apple は503 AUTH_NOT_CONFIGURED", async () => {
    const res = await app.request("/auth/apple", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identityToken: "x", deviceId: "d" }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("AUTH_NOT_CONFIGURED");
    expect(body.error.requestId).toEqual(expect.any(String));
  });

  it("POST /auth/refresh も503 AUTH_NOT_CONFIGURED", async () => {
    const res = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: "x", deviceId: "d" }),
    });
    expect(res.status).toBe(503);
  });

  it("GET /me も503 AUTH_NOT_CONFIGURED", async () => {
    const res = await app.request("/me", { method: "GET" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("AUTH_NOT_CONFIGURED");
  });

  it("公開GET /lotteries は影響を受けず200で動作する", async () => {
    const res = await app.request("/lotteries", { method: "GET" });
    expect(res.status).toBe(200);
  });

  it("POST /ingest（Bearer認証）も影響を受けない", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ sourcePost: { platform: "x", externalPostId: "999", authorUsername: "u" } }),
    });
    // 401/422等になり得るが、少なくとも503(AUTH_NOT_CONFIGURED)にはならない
    expect(res.status).not.toBe(503);
  });
});
