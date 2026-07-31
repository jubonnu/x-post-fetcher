/**
 * 公開GET API（/lotteries系）のCORS設定テスト。
 * /ingest・/internal/* にはCORSを適用しないことも確認する。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { publicApiCors } from "../src/publicCors.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-cors-${Date.now()}.db`);
const TOKEN = "test-token";
const ALLOWED_ORIGIN = "http://localhost:8081";
const DISALLOWED_ORIGIN = "https://evil.example.com";

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.INGEST_TOKEN = TOKEN;

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });
  await migrate(db, { migrationsFolder: "./migrations" });
  app = createApp(createDb);
});

afterAll(() => {
  rmSync(DB_FILE);
});

describe("public API CORS", () => {
  it("許可Originからの GET /lotteries には Access-Control-Allow-Origin が付く", async () => {
    const res = await app.request("/lotteries", {
      method: "GET",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("許可Originからの GET /lotteries/:id には Access-Control-Allow-Origin が付く", async () => {
    const res = await app.request("/lotteries/1", {
      method: "GET",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    // 存在しないIDでも404だがCORSヘッダーは付与される
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("存在しないID（404）のエラーレスポンスにも Access-Control-Allow-Origin が付く", async () => {
    const res = await app.request("/lotteries/999999", {
      method: "GET",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("不正なID（400）のエラーレスポンスにも Access-Control-Allow-Origin が付く", async () => {
    const res = await app.request("/lotteries/abc", {
      method: "GET",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("GET /lotteries には Vary: Origin が付く（Originごとに応答が変わるため）", async () => {
    const res = await app.request("/lotteries", {
      method: "GET",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  it("/lotteries と前方一致するだけの別ルート（/lotteries-export 等）は対象外", async () => {
    const res = await app.request("/lotteries-export", {
      method: "GET",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("OPTIONS /lotteries はプリフライトとして正常応答する", async () => {
    const res = await app.request("/lotteries", {
      method: "OPTIONS",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("未許可Originには Access-Control-Allow-Origin が付かない", async () => {
    const res = await app.request("/lotteries", {
      method: "GET",
      headers: { Origin: DISALLOWED_ORIGIN },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("POST /ingest には公開CORS設定が付かない", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { Origin: ALLOWED_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("/internal/* には公開CORS設定が付かない", async () => {
    const res = await app.request("/internal/review-items", {
      method: "GET",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("ハンドラが例外を投げた場合（500）でも Access-Control-Allow-Origin が付く", async () => {
    // publicCors.ts のミドルウェア単体の挙動を、実ルートを変更せずに検証するための
    // 隔離したテスト用Honoアプリ（本番の app.ts のルーティングには影響しない）。
    const boomApp = new Hono();
    boomApp.use("/boom", publicApiCors());
    boomApp.get("/boom", () => {
      throw new Error("boom");
    });

    const res = await boomApp.request("/boom", {
      method: "GET",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(500);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });
});
