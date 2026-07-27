/**
 * バックエンド堅牢化テスト（Phase 6 hardening）。
 * 1. approved/rejected 保護
 * 2. orphaned ライフサイクル（物理削除なし、公開API除外、再取込でactive復元）
 * 3. SSRF 対策（resolveUrl）
 * 4. GET /internal/jobs/next, POST /internal/jobs/:id/complete, POST /internal/jobs/:id/fail
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { lotteries, lotterySources, processingJobs, sourcePosts } from "../src/db/schema.ts";
import { syncLotteriesFromAnalysis, toLotteryRow } from "../src/repositories/lotteryRepository.ts";
import { resolveUrl } from "../src/services/resolveUrl.ts";
import type { ExtractedLottery } from "@x-post/shared";

const DB_FILE = resolve(process.cwd(), `.tmp-hardening-${Date.now()}.db`);
const TOKEN = "test-token";

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.INGEST_TOKEN = TOKEN;

let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof createDb>;

const auth = { Authorization: `Bearer ${TOKEN}` };
const post = (path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const get = (path: string) => app.request(path, { method: "GET", headers: auth });

/** テスト用の ExtractedLottery を作るヘルパー */
function makeLottery(overrides: Partial<ExtractedLottery> = {}): ExtractedLottery {
  return {
    productNameRaw: "テスト商品A",
    storeNameRaw: "テスト店",
    cardType: "pokemon",
    storeBranchRaw: null,
    region: null,
    applicationUrl: null,
    officialInformationUrl: null,
    appDownloadUrl: null,
    applicationMethod: null,
    eligibilityConditions: null,
    pickupMethod: null,
    paymentMethod: null,
    price: null,
    confirmedOpenAt: null,
    applicationStart: { at: null, date: null, precision: "unknown", status: "ok" },
    // precision: "date_only" → resolvedEndDate() がスコア計算対象にする
    applicationEnd: { at: null, date: "2025-12-31", precision: "date_only", status: "ok" },
    resultAnnouncement: { at: null, date: null, precision: "unknown", status: "ok" },
    purchaseStart: { at: null, date: null, precision: "unknown", status: "ok" },
    purchaseDeadline: { at: null, date: null, precision: "unknown", status: "ok" },
    ...overrides,
  };
}

beforeAll(async () => {
  db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });
  await migrate(db, { migrationsFolder: "./migrations" });
  app = createApp(createDb);
});

afterAll(() => {
  rmSync(DB_FILE);
});

// ============================================================
// 1. approved/rejected 保護
// ============================================================
describe("approved/rejected 保護", () => {
  it("rejected lottery は自動取込で変更されない", async () => {
    // rejected lottery を直接挿入
    const [inserted] = await db
      .insert(lotteries)
      .values({
        productNameRaw: "却下商品",
        normalizedProductName: "却下商品",
        cardType: "pokemon",
        storeNameRaw: "テスト店",
        normalizedStoreName: "テスト店",
        verificationStatus: "rejected",
        lifecycleStatus: "active",
        status: "open",
      })
      .returning({ id: lotteries.id });

    const [sp] = await db
      .insert(sourcePosts)
      .values({
        platform: "x",
        externalPostId: `rejected-test-${Date.now()}`,
        sourceUrl: "https://x.com/test/1",
        bodyRaw: "却下テスト",
        contentHash: `hash-rejected-${Date.now()}`,
        fetchedAt: new Date().toISOString(),
      })
      .returning({ id: sourcePosts.id });

    // 同一商品・同一店舗の候補を送り込む（merge になるはず → でも保護される）
    const candidate = toLotteryRow(sp.id, makeLottery({ productNameRaw: "却下商品", storeNameRaw: "テスト店" }));
    await syncLotteriesFromAnalysis(db, sp.id, [candidate]);

    // DB で rejected のままであることを確認
    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, inserted.id));
    expect(row.verificationStatus).toBe("rejected");
  });

  it("approved lottery は自動取込で needs_review に降格する（フィールドは保護）", async () => {
    const [inserted] = await db
      .insert(lotteries)
      .values({
        productNameRaw: "承認済み商品",
        normalizedProductName: "承認済み商品",
        cardType: "pokemon",
        storeNameRaw: "テスト店",
        normalizedStoreName: "テスト店",
        verificationStatus: "approved",
        lifecycleStatus: "active",
        status: "open",
        applicationEndDate: "2025-12-31",
        applicationEndPrecision: "date_only",
      })
      .returning({ id: lotteries.id });

    const [sp] = await db
      .insert(sourcePosts)
      .values({
        platform: "x",
        externalPostId: `approved-test-${Date.now()}`,
        sourceUrl: "https://x.com/test/2",
        bodyRaw: "承認テスト",
        contentHash: `hash-approved-${Date.now()}`,
        fetchedAt: new Date().toISOString(),
      })
      .returning({ id: sourcePosts.id });

    const candidate = toLotteryRow(sp.id, makeLottery({ productNameRaw: "承認済み商品", storeNameRaw: "テスト店" }));
    await syncLotteriesFromAnalysis(db, sp.id, [candidate]);

    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, inserted.id));
    // approved → needs_review に降格（要再確認）
    expect(row.verificationStatus).toBe("needs_review");
  });

  it("rejected lottery は GET /lotteries に表示されない", async () => {
    // rejected lottery を作成
    await db.insert(lotteries).values({
      productNameRaw: "非表示商品",
      normalizedProductName: "非表示商品",
      cardType: "pokemon",
      verificationStatus: "rejected",
      lifecycleStatus: "active",
      status: "open",
    });

    const res = await app.request("/lotteries", { method: "GET" });
    const json: any = await res.json();
    const hasRejected = json.lotteries.some((l: any) => l.verificationStatus === "rejected");
    expect(hasRejected).toBe(false);
  });
});

// ============================================================
// 2. orphaned ライフサイクル
// ============================================================
describe("orphaned lifecycle", () => {
  it("source が取り除かれると lottery が物理削除されずに orphaned になる", async () => {
    const [sp] = await db
      .insert(sourcePosts)
      .values({
        platform: "x",
        externalPostId: `orphan-src-${Date.now()}`,
        sourceUrl: "https://x.com/test/3",
        bodyRaw: "孤立テスト",
        contentHash: `hash-orphan-${Date.now()}`,
        fetchedAt: new Date().toISOString(),
      })
      .returning({ id: sourcePosts.id });

    // lottery を作成して source にリンク
    const candidate = toLotteryRow(sp.id, makeLottery({ productNameRaw: `孤立商品-${Date.now()}`, storeNameRaw: "テスト店" }));
    const result = await syncLotteriesFromAnalysis(db, sp.id, [candidate]);
    const lotteryId = result.results[0].lotteryId;

    // 初期状態は active
    const [before] = await db.select().from(lotteries).where(eq(lotteries.id, lotteryId));
    expect(before.lifecycleStatus).toBe("active");
    expect(before.orphanedAt).toBeNull();

    // source を unlinkするため、空の候補で再解析を実行（contributions を削除する）
    await syncLotteriesFromAnalysis(db, sp.id, []); // candidates=[] → unlink のみ

    // 物理削除されていないが orphaned になっている
    const rows = await db.select().from(lotteries).where(eq(lotteries.id, lotteryId));
    expect(rows).toHaveLength(1); // 物理削除されていない
    expect(rows[0].lifecycleStatus).toBe("orphaned");
    expect(rows[0].orphanedAt).toBeTruthy();
  });

  it("orphaned lottery は GET /lotteries に表示されない", async () => {
    const res = await app.request("/lotteries", { method: "GET" });
    const json: any = await res.json();
    const hasOrphaned = json.lotteries.some((l: any) => l.lifecycleStatus !== "active");
    expect(hasOrphaned).toBe(false);
  });

  it("orphaned lottery は再取込時に active に復元される", async () => {
    const externalPostId = `restore-src-${Date.now()}`;
    const [sp] = await db
      .insert(sourcePosts)
      .values({
        platform: "x",
        externalPostId,
        sourceUrl: "https://x.com/test/4",
        bodyRaw: "復元テスト",
        contentHash: `hash-restore-${Date.now()}`,
        fetchedAt: new Date().toISOString(),
      })
      .returning({ id: sourcePosts.id });

    const productName = `復元商品-${Date.now()}`;
    const candidate = toLotteryRow(sp.id, makeLottery({ productNameRaw: productName, storeNameRaw: "テスト店" }));
    const result1 = await syncLotteriesFromAnalysis(db, sp.id, [candidate]);
    const lotteryId = result1.results[0].lotteryId;

    // orphaned にする
    await syncLotteriesFromAnalysis(db, sp.id, []);
    const [orphaned] = await db.select().from(lotteries).where(eq(lotteries.id, lotteryId));
    expect(orphaned.lifecycleStatus).toBe("orphaned");

    // 再取込（同一商品・店舗で merge）
    const [sp2] = await db
      .insert(sourcePosts)
      .values({
        platform: "x",
        externalPostId: `${externalPostId}-2`,
        sourceUrl: "https://x.com/test/4b",
        bodyRaw: "復元テスト2",
        contentHash: `hash-restore2-${Date.now()}`,
        fetchedAt: new Date().toISOString(),
      })
      .returning({ id: sourcePosts.id });

    const candidate2 = toLotteryRow(sp2.id, makeLottery({ productNameRaw: productName, storeNameRaw: "テスト店" }));
    await syncLotteriesFromAnalysis(db, sp2.id, [candidate2]);

    const [restored] = await db.select().from(lotteries).where(eq(lotteries.id, lotteryId));
    expect(restored.lifecycleStatus).toBe("active");
    expect(restored.orphanedAt).toBeNull();
  });
});

// ============================================================
// 3. SSRF 対策（resolveUrl）
// ============================================================
describe("SSRF 対策（resolveUrl）", () => {
  it("http://127.0.0.1 はブロックされる", async () => {
    const result = await resolveUrl("http://127.0.0.1/secret");
    expect(result.resolvedUrl).toBeNull();
    expect(result.errorCode).toMatch(/loopback_address|private_address/);
  });

  it("http://10.0.0.1 はブロックされる", async () => {
    const result = await resolveUrl("http://10.0.0.1/");
    expect(result.resolvedUrl).toBeNull();
    expect(result.errorCode).toBe("private_address");
  });

  it("http://192.168.1.1 はブロックされる", async () => {
    const result = await resolveUrl("http://192.168.1.1/");
    expect(result.resolvedUrl).toBeNull();
    expect(result.errorCode).toBe("private_address");
  });

  it("http://169.254.169.254 はブロックされる（link-local）", async () => {
    const result = await resolveUrl("http://169.254.169.254/latest/meta-data/");
    expect(result.resolvedUrl).toBeNull();
    expect(result.errorCode).toMatch(/link_local_address|private_address/);
  });

  it("認証情報付き URL はブロックされる", async () => {
    const result = await resolveUrl("http://user:pass@example.com/");
    expect(result.resolvedUrl).toBeNull();
    expect(result.errorCode).toBe("credentials_in_url");
  });

  it("file:// スキームはブロックされる", async () => {
    const result = await resolveUrl("file:///etc/passwd");
    expect(result.resolvedUrl).toBeNull();
    expect(result.errorCode).toBe("invalid_scheme");
  });

  it("javascript:// スキームはブロックされる", async () => {
    const result = await resolveUrl("javascript:alert(1)");
    expect(result.resolvedUrl).toBeNull();
    expect(result.errorCode).toBe("invalid_scheme");
  });

  it("2048文字超 URL はブロックされる", async () => {
    const longUrl = "https://example.com/" + "a".repeat(2050);
    const result = await resolveUrl(longUrl);
    expect(result.resolvedUrl).toBeNull();
    expect(result.errorCode).toBe("url_too_long");
  });
});

// ============================================================
// 4. GET /internal/jobs/next, POST /internal/jobs/:id/complete, POST /internal/jobs/:id/fail
// ============================================================
describe("analyze_post ジョブ管理 API", () => {
  let jobSourcePostId: number;

  beforeAll(async () => {
    // テスト用 source_post を作成してジョブをエンキュー
    const [sp] = await db
      .insert(sourcePosts)
      .values({
        platform: "x",
        externalPostId: `job-test-${Date.now()}`,
        sourceUrl: "https://x.com/test/job",
        bodyRaw: "ジョブテスト投稿",
        contentHash: `hash-job-${Date.now()}`,
        fetchedAt: new Date().toISOString(),
      })
      .returning({ id: sourcePosts.id });
    jobSourcePostId = sp.id;

    // reanalyze エンドポイントでジョブをエンキュー
    await post(`/internal/source-posts/${jobSourcePostId}/reanalyze`);
  });

  it("認証なしは 401", async () => {
    const res = await app.request("/internal/jobs/next?type=analyze_post", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("GET /internal/jobs/next でジョブを取得できる", async () => {
    const res = await get("/internal/jobs/next?type=analyze_post");
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(json.job).not.toBeNull();
    expect(json.job.jobId).toBeTypeOf("number");
    expect(json.job.sourcePostId).toBe(jobSourcePostId);
    expect(json.job.sourcePost).not.toBeNull();
    expect(json.job.sourcePost.bodyRaw).toBe("ジョブテスト投稿");
    // ジョブは running 状態になっているはず
    const jobs = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, json.job.jobId));
    expect(jobs[0].status).toBe("running");

    // 完了報告
    const completeRes = await post(`/internal/jobs/${json.job.jobId}/complete`);
    expect(completeRes.status).toBe(200);
    const completeJson: any = await completeRes.json();
    expect(completeJson.ok).toBe(true);

    const [completed] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, json.job.jobId));
    expect(completed.status).toBe("done");
    expect(completed.completedAt).toBeTruthy();
  });

  it("ジョブがなければ job=null を返す", async () => {
    // 全ジョブが done になった後
    const res = await get("/internal/jobs/next?type=analyze_post");
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(json.job).toBeNull();
  });

  it("POST /internal/jobs/:id/fail でジョブが失敗としてリトライスケジュールされる", async () => {
    // 新しいジョブを作成
    const [sp] = await db
      .insert(sourcePosts)
      .values({
        platform: "x",
        externalPostId: `fail-test-${Date.now()}`,
        sourceUrl: "https://x.com/test/fail",
        bodyRaw: "失敗テスト",
        contentHash: `hash-fail-${Date.now()}`,
        fetchedAt: new Date().toISOString(),
      })
      .returning({ id: sourcePosts.id });
    await post(`/internal/source-posts/${sp.id}/reanalyze`);

    // デキュー
    const nextRes = await get("/internal/jobs/next?type=analyze_post");
    const { job } = (await nextRes.json()) as any;
    expect(job).not.toBeNull();

    // 失敗報告
    const failRes = await post(`/internal/jobs/${job.jobId}/fail`, { error: "テストエラー" });
    expect(failRes.status).toBe(200);
    const failJson: any = await failRes.json();
    expect(failJson.ok).toBe(true);

    // attempts < maxAttempts なので pending に戻ってリトライ待ち
    const [row] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, job.jobId));
    expect(row.status).toBe("pending");
    expect(row.lastError).toBe("テストエラー");
    expect(row.nextRetryAt).toBeTruthy();
  });

  it("POST /internal/jobs/:id/fail — 存在しない ID は 404", async () => {
    const res = await post("/internal/jobs/99999/fail", { error: "not found" });
    expect(res.status).toBe(404);
  });

  it("unsupported_job_type は 400", async () => {
    const res = await get("/internal/jobs/next?type=unknown_type");
    expect(res.status).toBe(400);
  });
});
