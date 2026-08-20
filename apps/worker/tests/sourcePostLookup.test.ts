import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-test-${Date.now()}-lookup.db`);
const TOKEN = "test-token";

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.INGEST_TOKEN = TOKEN;

let app: ReturnType<typeof import("../src/app.ts")["createApp"]>;

const ingest = (externalPostId: string, publishedAt: string, authorUsername = "zabi_poc") =>
  app.request("/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      sourcePost: {
        externalPostId,
        authorUsername,
        sourceUrl: `https://x.com/${authorUsername}/status/${externalPostId}`,
        bodyRaw: "本文",
        publishedAt,
        contentHash: `hash-${externalPostId}`,
        fetchedAt: new Date().toISOString(),
      },
    }),
  });

const lookup = (authorUsername: string, params: Record<string, string> = {}, token?: string) => {
  const qs = new URLSearchParams({ authorUsername, ...params }).toString();
  return app.request(`/internal/source-posts/known-external-ids?${qs}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
};

const reportRunResult = (
  authorUsername: string,
  needsRecovery: boolean,
  token?: string,
  cursor?: { recoveryCursorExternalPostId?: string | null; recoveryCursorPublishedAt?: string | null }
) =>
  app.request("/internal/source-posts/scrape-run-result", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ authorUsername, needsRecovery, ...cursor }),
  });

beforeAll(async () => {
  const db = createDb({ TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL });
  await migrate(db, { migrationsFolder: "./migrations" });
  const mod = await import("../src/app.ts");
  app = mod.createApp(createDb);

  await ingest("3001", "2026-08-01T00:00:00.000Z");
  await ingest("3002", "2026-08-02T00:00:00.000Z");
  await ingest("3003", "2026-08-03T00:00:00.000Z");
  await ingest("9001", "2026-08-03T00:00:00.000Z", "other_user");
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

describe("GET /internal/source-posts/known-external-ids", () => {
  it("Bearer なしは 401", async () => {
    const res = await lookup("zabi_poc");
    expect(res.status).toBe(401);
  });

  it("誤ったトークンは 401", async () => {
    const res = await lookup("zabi_poc", {}, "wrong");
    expect(res.status).toBe(401);
  });

  it("authorUsername 未指定は 400", async () => {
    const res = await app.request("/internal/source-posts/known-external-ids", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
  });

  it("対象ユーザーの externalPostId を publishedAt 降順で返す", async () => {
    const res = await lookup("zabi_poc", {}, TOKEN);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(json.externalPostIds).toEqual(["3003", "3002", "3001"]);
  });

  it("authorUsername は大文字小文字を無視する", async () => {
    const res = await lookup("ZABI_POC", {}, TOKEN);
    const json: any = await res.json();
    expect(json.externalPostIds).toEqual(["3003", "3002", "3001"]);
  });

  it("別ユーザーの投稿は含まれない", async () => {
    const res = await lookup("zabi_poc", {}, TOKEN);
    const json: any = await res.json();
    expect(json.externalPostIds).not.toContain("9001");
  });

  it("limit で件数を制限できる", async () => {
    const res = await lookup("zabi_poc", { limit: "2" }, TOKEN);
    const json: any = await res.json();
    expect(json.externalPostIds).toEqual(["3003", "3002"]);
  });

  it("未知のユーザーは空配列", async () => {
    const res = await lookup("nobody", {}, TOKEN);
    const json: any = await res.json();
    expect(json.externalPostIds).toEqual([]);
  });

  it("状態未記録の場合 needsRecovery は false", async () => {
    const res = await lookup("zabi_poc", {}, TOKEN);
    const json: any = await res.json();
    expect(json.needsRecovery).toBe(false);
  });
});

describe("POST /internal/source-posts/scrape-run-result", () => {
  it("Bearer なしは 401", async () => {
    const res = await reportRunResult("zabi_poc", true);
    expect(res.status).toBe(401);
  });

  it("authorUsername/needsRecovery 欠落は 400", async () => {
    const res = await app.request("/internal/source-posts/scrape-run-result", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("needsRecovery=true を記録すると、以降の known-external-ids は limit を無視して全件返す（リカバリーモード）", async () => {
    const before = await reportRunResult("recovery_user", true, TOKEN);
    expect(before.status).toBe(200);

    for (let i = 1; i <= 5; i++) {
      await ingest(`r${i}`, `2026-08-0${i}T00:00:00.000Z`, "recovery_user");
    }

    const res = await lookup("recovery_user", { limit: "2" }, TOKEN);
    const json: any = await res.json();
    expect(json.needsRecovery).toBe(true);
    expect(json.externalPostIds.length).toBe(5); // limit=2 を指定しても無視され全件返る
  });

  it("needsRecovery=false を記録すると通常モード（limit有効）へ自己修復する", async () => {
    await reportRunResult("recovery_user", false, TOKEN);
    const res = await lookup("recovery_user", { limit: "2" }, TOKEN);
    const json: any = await res.json();
    expect(json.needsRecovery).toBe(false);
    expect(json.externalPostIds.length).toBe(2);
  });

  it("同じauthorUsernameへの再報告は上書きされる（行が増殖しない）", async () => {
    await reportRunResult("toggle_user", true, TOKEN);
    await reportRunResult("toggle_user", false, TOKEN);
    await reportRunResult("toggle_user", true, TOKEN);
    const res = await lookup("toggle_user", {}, TOKEN);
    const json: any = await res.json();
    expect(json.needsRecovery).toBe(true);
  });

  it("recoveryCursorを保存すると known-external-ids のレスポンスに含まれる", async () => {
    await reportRunResult("cursor_user", true, TOKEN, {
      recoveryCursorExternalPostId: "5001",
      recoveryCursorPublishedAt: "2026-07-01T00:00:00.000Z",
    });
    const res = await lookup("cursor_user", {}, TOKEN);
    const json: any = await res.json();
    expect(json.needsRecovery).toBe(true);
    expect(json.recoveryCursorExternalPostId).toBe("5001");
    expect(json.recoveryCursorPublishedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("needsRecovery=falseかつcursor=nullを報告するとcursorが解除される", async () => {
    await reportRunResult("cursor_user2", true, TOKEN, {
      recoveryCursorExternalPostId: "6001",
      recoveryCursorPublishedAt: "2026-07-02T00:00:00.000Z",
    });
    await reportRunResult("cursor_user2", false, TOKEN, {
      recoveryCursorExternalPostId: null,
      recoveryCursorPublishedAt: null,
    });
    const res = await lookup("cursor_user2", {}, TOKEN);
    const json: any = await res.json();
    expect(json.needsRecovery).toBe(false);
    expect(json.recoveryCursorExternalPostId).toBeNull();
    expect(json.recoveryCursorPublishedAt).toBeNull();
  });

  it("cursorを省略した報告は既存cursorを変更しない", async () => {
    await reportRunResult("cursor_user3", true, TOKEN, {
      recoveryCursorExternalPostId: "7001",
      recoveryCursorPublishedAt: "2026-07-03T00:00:00.000Z",
    });
    await reportRunResult("cursor_user3", true, TOKEN); // cursorフィールド省略
    const res = await lookup("cursor_user3", {}, TOKEN);
    const json: any = await res.json();
    expect(json.recoveryCursorExternalPostId).toBe("7001");
    expect(json.recoveryCursorPublishedAt).toBe("2026-07-03T00:00:00.000Z");
  });

  it("recoveryCursorExternalPostIdが文字列/null以外なら400", async () => {
    const res = await app.request("/internal/source-posts/scrape-run-result", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ authorUsername: "bad_cursor_user", needsRecovery: true, recoveryCursorExternalPostId: 123 }),
    });
    expect(res.status).toBe(400);
  });
});
