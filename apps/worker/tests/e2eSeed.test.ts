/**
 * Phase 7: `POST /internal/e2e-seed`はE2E専用のため、E2E_SEED_ENABLED未設定なら
 * 必ず404になること（fail-closed）を確認する。staging/productionへの誤混入対策。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-e2e-seed-${Date.now()}.db`);

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.INGEST_TOKEN = "test-ingest-token";

function authHeaders() {
  return { Authorization: `Bearer ${process.env.INGEST_TOKEN}` };
}

let app: ReturnType<typeof createApp>;
const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  app = createApp(createDb);
});

afterAll(() => {
  rmSync(DB_FILE);
});

describe("POST /internal/e2e-seed", () => {
  it("INGEST_TOKEN無しは401（/internal/*共通ミドルウェア）", async () => {
    process.env.E2E_SEED_ENABLED = "true";
    try {
      const res = await app.request("/internal/e2e-seed", { method: "POST" });
      expect(res.status).toBe(401);
    } finally {
      delete process.env.E2E_SEED_ENABLED;
    }
  });

  it("INGEST_TOKENがあってもE2E_SEED_ENABLED未設定なら404（fail-closed）", async () => {
    delete process.env.E2E_SEED_ENABLED;
    const res = await app.request("/internal/e2e-seed", { method: "POST", headers: authHeaders() });
    expect(res.status).toBe(404);
  });

  it("INGEST_TOKEN + E2E_SEED_ENABLED='true'の場合のみ抽選を1件作成する", async () => {
    process.env.E2E_SEED_ENABLED = "true";
    try {
      const res = await app.request("/internal/e2e-seed", { method: "POST", headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; id: number };
      expect(body.ok).toBe(true);
      expect(typeof body.id).toBe("number");
    } finally {
      delete process.env.E2E_SEED_ENABLED;
    }
  });

  it("'true'以外の値（例: '1'）では404のまま", async () => {
    process.env.E2E_SEED_ENABLED = "1";
    try {
      const res = await app.request("/internal/e2e-seed", { method: "POST", headers: authHeaders() });
      expect(res.status).toBe(404);
    } finally {
      delete process.env.E2E_SEED_ENABLED;
    }
  });
});
