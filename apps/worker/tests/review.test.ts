/**
 * 内部管理 API テスト（Phase 5）。
 * GET/POST /internal/review-items, POST /internal/source-posts/:id/reanalyze
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { lotteries, processingJobs, sourcePosts } from "../src/db/schema.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-review-${Date.now()}.db`);
const TOKEN = "test-token";

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.INGEST_TOKEN = TOKEN;

let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof createDb>;
let reviewItemId: number;
let sourcePostId: number;

const auth = { Authorization: `Bearer ${TOKEN}` };
const post = (path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const get = (path: string) => app.request(path, { method: "GET", headers: auth });

beforeAll(async () => {
  db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });
  await migrate(db, { migrationsFolder: "./migrations" });

  // needs_review な抽選と source_post を挿入
  const [inserted] = await db
    .insert(lotteries)
    .values({
      productNameRaw: "テスト商品",
      normalizedProductName: "テスト商品",
      cardType: "pokemon",
      storeNameRaw: "テスト店",
      normalizedStoreName: "テスト店",
      verificationStatus: "needs_review",
      status: "open",
    })
    .returning({ id: lotteries.id });
  reviewItemId = inserted.id;

  const [sp] = await db
    .insert(sourcePosts)
    .values({
      platform: "x",
      externalPostId: "test-post-for-reanalyze",
      sourceUrl: "https://x.com/test/status/1",
      bodyRaw: "テスト投稿",
      contentHash: "testhash",
      fetchedAt: new Date().toISOString(),
    })
    .returning({ id: sourcePosts.id });
  sourcePostId = sp.id;

  app = createApp(createDb);
});

afterAll(() => {
  rmSync(DB_FILE);
});

describe("GET /internal/review-items", () => {
  it("認証なしは 401", async () => {
    const res = await app.request("/internal/review-items", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("needs_review の一覧を返す", async () => {
    const res = await get("/internal/review-items");
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(json.items.length).toBeGreaterThanOrEqual(1);
    expect(json.items.some((i: any) => i.id === reviewItemId)).toBe(true);
  });

  it("status クエリでフィルタできる", async () => {
    const res = await get("/internal/review-items?status=extracted");
    const json: any = await res.json();
    expect(json.items.every((i: any) => i.verificationStatus === "extracted")).toBe(true);
  });
});

describe("GET /internal/review-items/:id", () => {
  it("詳細（sources + fieldHistory 付き）を返す", async () => {
    const res = await get(`/internal/review-items/${reviewItemId}`);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(json.lottery.id).toBe(reviewItemId);
    expect(Array.isArray(json.sources)).toBe(true);
    expect(Array.isArray(json.fieldHistory)).toBe(true);
  });

  it("存在しない ID は 404", async () => {
    const res = await get("/internal/review-items/99999");
    expect(res.status).toBe(404);
  });
});

describe("POST /internal/review-items/:id/approve", () => {
  it("認証なしは 401", async () => {
    const res = await app.request(`/internal/review-items/${reviewItemId}/approve`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("承認で verificationStatus が approved になる", async () => {
    const res = await post(`/internal/review-items/${reviewItemId}/approve`, { approvedBy: "admin" });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(json.verificationStatus).toBe("approved");
    expect(json.approvedAt).toBeTruthy();

    // DB でも確認
    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, reviewItemId));
    expect(row.verificationStatus).toBe("approved");
    expect(row.approvedBy).toBe("admin");
    expect(row.approvedAt).toBeTruthy();
  });
});

describe("POST /internal/review-items/:id/reject", () => {
  it("却下で verificationStatus が rejected になる", async () => {
    // 別の抽選を作成
    const [other] = await db
      .insert(lotteries)
      .values({
        productNameRaw: "別商品",
        normalizedProductName: "別商品",
        cardType: "pokemon",
        verificationStatus: "needs_review",
        status: "open",
      })
      .returning({ id: lotteries.id });

    const res = await post(`/internal/review-items/${other.id}/reject`, { reason: "情報が不完全" });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(json.verificationStatus).toBe("rejected");

    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, other.id));
    expect(row.verificationStatus).toBe("rejected");
    expect(row.rejectedReason).toBe("情報が不完全");
    expect(row.rejectedAt).toBeTruthy();
  });

  it("存在しない ID は 404", async () => {
    const res = await post("/internal/review-items/99999/reject", { reason: "not found" });
    expect(res.status).toBe(404);
  });
});

describe("POST /internal/source-posts/:id/reanalyze", () => {
  it("processing_jobs に analyze_post ジョブがエンキューされる", async () => {
    const res = await post(`/internal/source-posts/${sourcePostId}/reanalyze`);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(json.sourcePostId).toBe(sourcePostId);
    expect(json.enqueued).toBe(true);

    // DB でジョブが作成されていることを確認
    const jobs = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.sourcePostId, sourcePostId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobType).toBe("analyze_post");
    expect(jobs[0].status).toBe("pending");
  });

  it("重複エンキューはスキップされる（enqueued=false）", async () => {
    const res = await post(`/internal/source-posts/${sourcePostId}/reanalyze`);
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(json.enqueued).toBe(false); // 既に pending ジョブあり

    const jobs = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.sourcePostId, sourcePostId));
    expect(jobs).toHaveLength(1); // 増えていない
  });

  it("存在しない sourcePostId は 404", async () => {
    const res = await post("/internal/source-posts/99999/reanalyze");
    expect(res.status).toBe(404);
  });
});
