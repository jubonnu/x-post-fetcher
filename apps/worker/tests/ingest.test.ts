import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-test-${Date.now()}.db`);
const TOKEN = "test-token";

// createApp は import 時ではなく request 時に process.env を読むため、先に env を設定
process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.INGEST_TOKEN = TOKEN;

let app: ReturnType<typeof import("../src/app.ts")["createApp"]>;

const baseSourcePost = () => ({
  externalPostId: "1988548187880059026",
  sourceUrl: "https://x.com/zabi_poc/status/1988548187880059026",
  bodyRaw: "抽選開始されました",
  publishedAt: "2026-07-23T12:52:18.000Z",
  contentHash: "hash-v1",
  fetchedAt: new Date().toISOString(),
});

const post = (body: unknown, token?: string) =>
  app.request("/ingest", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  const db = createDb({ TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL });
  await migrate(db, { migrationsFolder: "./migrations" });
  const mod = await import("../src/app.ts");
  app = mod.createApp(createDb);
});

afterAll(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB_FILE + ext);
    } catch {
      /* ignore */
    }
  }
});

describe("POST /ingest", () => {
  it("Bearer なしは 401", async () => {
    const res = await post({ sourcePost: baseSourcePost() });
    expect(res.status).toBe(401);
  });

  it("誤ったトークンは 401", async () => {
    const res = await post({ sourcePost: baseSourcePost() }, "wrong");
    expect(res.status).toBe(401);
  });

  it("sourcePost のみ（analysis なし）で inserted", async () => {
    const res = await post({ sourcePost: baseSourcePost() }, TOKEN);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(json.action).toBe("inserted");
    expect(json.externalPostId).toBe("1988548187880059026");
  });

  it("同一 contentHash の再送は unchanged（重複登録されない）", async () => {
    const res = await post({ sourcePost: baseSourcePost() }, TOKEN);
    const json: any = await res.json();
    expect(json.action).toBe("unchanged");
  });

  it("contentHash が変われば updated", async () => {
    const changed = { ...baseSourcePost(), contentHash: "hash-v2", bodyRaw: "締切延長しました" };
    const res = await post({ sourcePost: changed }, TOKEN);
    const json: any = await res.json();
    expect(json.action).toBe("updated");
  });

  it("externalPostId 欠落は 422", async () => {
    const bad = { ...baseSourcePost(), externalPostId: "" };
    const res = await post({ sourcePost: bad }, TOKEN);
    expect(res.status).toBe(422);
  });
});
