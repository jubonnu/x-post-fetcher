/**
 * バックエンド堅牢化テスト（Phase 6 hardening）。
 * 1. approved/rejected 保護
 * 2. orphaned ライフサイクル（物理削除なし、公開API除外、再取込でactive復元）
 * 3. SSRF 対策（resolveUrl）
 * 4. GET /internal/jobs/next, POST /internal/jobs/:id/complete, POST /internal/jobs/:id/fail
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { lotteries, lotteryUpdateCandidates, processingJobs, sourcePosts } from "../src/db/schema.ts";
import { syncLotteriesFromAnalysis, toLotteryRow } from "../src/repositories/lotteryRepository.ts";
import { getLotteryUpdateCandidateDiff } from "../src/repositories/lotteryUpdateCandidateRepository.ts";
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
    resultAnnouncementStart: { at: null, date: null, precision: "unknown", status: "ok" },
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

  it("approved lottery は完全同一内容の再取込で approved を維持する", async () => {
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
        approvedBy: "admin",
        approvedAt: "2025-11-01T00:00:00.000Z",
      })
      .returning({ id: lotteries.id });

    const [sp] = await db
      .insert(sourcePosts)
      .values({
        platform: "x",
        externalPostId: `approved-same-${Date.now()}`,
        sourceUrl: "https://x.com/test/2",
        bodyRaw: "承認テスト（同一内容）",
        contentHash: `hash-approved-same-${Date.now()}`,
        fetchedAt: new Date().toISOString(),
      })
      .returning({ id: sourcePosts.id });

    // 同一の商品・店舗・締切で再取込（conflicts なし）
    const candidate = toLotteryRow(sp.id, makeLottery({ productNameRaw: "承認済み商品", storeNameRaw: "テスト店" }));
    await syncLotteriesFromAnalysis(db, sp.id, [candidate]);

    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, inserted.id));
    // 同一内容 → approved 維持
    expect(row.verificationStatus).toBe("approved");
    // approvedBy / approvedAt が監査情報として維持されている
    expect(row.approvedBy).toBe("admin");
    expect(row.approvedAt).toBe("2025-11-01T00:00:00.000Z");
  });

  it("approved lottery は一致する後続投稿でも自動更新されず、更新候補として保留される（Phase 11）", async () => {
    const [inserted] = await db
      .insert(lotteries)
      .values({
        productNameRaw: "承認済み商品B",
        normalizedProductName: "承認済み商品B",
        cardType: "pokemon",
        storeNameRaw: "テスト店",
        normalizedStoreName: "テスト店",
        verificationStatus: "approved",
        lifecycleStatus: "active",
        status: "open",
        applicationEndDate: "2025-12-31",
        applicationEndPrecision: "date_only",
        applicationUrl: null, // ← 空欄
        approvedBy: "admin",
        approvedAt: "2025-11-01T00:00:00.000Z",
      })
      .returning({ id: lotteries.id });

    const [sp] = await db
      .insert(sourcePosts)
      .values({
        platform: "x",
        externalPostId: `approved-fill-${Date.now()}`,
        sourceUrl: "https://x.com/test/fill",
        bodyRaw: "承認テスト（空欄補完）",
        contentHash: `hash-approved-fill-${Date.now()}`,
        fetchedAt: new Date().toISOString(),
      })
      .returning({ id: sourcePosts.id });

    // applicationUrl を持つ候補（別のsourcePostからの後続投稿）
    const candidate = toLotteryRow(
      sp.id,
      makeLottery({
        productNameRaw: "承認済み商品B",
        storeNameRaw: "テスト店",
        applicationUrl: "https://apply.example.com",
      })
    );
    const synced = await syncLotteriesFromAnalysis(db, sp.id, [candidate]);

    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, inserted.id));
    // 自動書き込みしない → approved・applicationUrlともに変更されない
    expect(row.verificationStatus).toBe("approved");
    expect(row.applicationUrl).toBeNull();
    expect(row.approvedBy).toBe("admin");
    expect(row.approvedAt).toBe("2025-11-01T00:00:00.000Z");

    // 代わりに更新候補として保留される
    expect(synced.results[0].matchAction).toBe("candidate");
    const candidates = await db
      .select()
      .from(lotteryUpdateCandidates)
      .where(eq(lotteryUpdateCandidates.targetLotteryId, inserted.id));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("pending");
  });

  it("approved lottery は重要フィールドが競合する後続投稿でも自動では変更されず、更新候補として保留される（Phase 11）", async () => {
    const [inserted] = await db
      .insert(lotteries)
      .values({
        productNameRaw: "承認済み商品C",
        normalizedProductName: "承認済み商品C",
        cardType: "pokemon",
        storeNameRaw: "テスト店",
        normalizedStoreName: "テスト店",
        verificationStatus: "approved",
        lifecycleStatus: "active",
        status: "open",
        applicationEndDate: "2025-12-31",
        applicationEndPrecision: "date_only",
        applicationUrl: "https://old.example.com", // ← 競合対象
        approvedBy: "admin",
        approvedAt: "2025-11-01T00:00:00.000Z",
      })
      .returning({ id: lotteries.id });

    const [sp] = await db
      .insert(sourcePosts)
      .values({
        platform: "x",
        externalPostId: `approved-conflict-${Date.now()}`,
        sourceUrl: "https://x.com/test/conflict",
        bodyRaw: "承認テスト（競合）",
        contentHash: `hash-approved-conflict-${Date.now()}`,
        fetchedAt: new Date().toISOString(),
      })
      .returning({ id: sourcePosts.id });

    // applicationUrl が異なる候補（別のsourcePostからの後続投稿）
    const candidate = toLotteryRow(
      sp.id,
      makeLottery({
        productNameRaw: "承認済み商品C",
        storeNameRaw: "テスト店",
        applicationUrl: "https://new.example.com", // ← 既存と異なる値
      })
    );
    const synced = await syncLotteriesFromAnalysis(db, sp.id, [candidate]);

    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, inserted.id));
    // 自動書き込みしない → approved・applicationUrlともに変更されない（needs_reviewへの自動降格も廃止）
    expect(row.verificationStatus).toBe("approved");
    expect(row.applicationUrl).toBe("https://old.example.com");
    expect(row.approvedBy).toBe("admin");
    expect(row.approvedAt).toBe("2025-11-01T00:00:00.000Z");

    // 代わりに更新候補として保留され、applicationUrlはconflictingフィールドとして扱われる（管理画面の差分表示用）
    expect(synced.results[0].matchAction).toBe("candidate");
    const candidates = await db
      .select()
      .from(lotteryUpdateCandidates)
      .where(eq(lotteryUpdateCandidates.targetLotteryId, inserted.id));
    expect(candidates).toHaveLength(1);
    const diff = await getLotteryUpdateCandidateDiff(db, candidates[0].id);
    expect(diff?.conflictingFields.some((f) => f.fieldName === "applicationUrl")).toBe(true);
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
// 2. 自身の投稿の再解析（parserVersion更新等）: own_updated / own_confirmed_skipped
//    （Phase 11で、unlink→orphaned→rematch→merge/newの再構築サイクルを廃止して置き換えた挙動）
// ============================================================
describe("own-lottery reconciliation（同一投稿の再解析）", () => {
  it("未承認の自分のlotteryは、同じ投稿の再解析で内容が置き換わる（own_updated、重複挿入しない）", async () => {
    const [sp] = await db
      .insert(sourcePosts)
      .values({
        platform: "x",
        externalPostId: `own-update-${Date.now()}`,
        sourceUrl: "https://x.com/test/own",
        bodyRaw: "自己更新テスト",
        contentHash: `hash-own-update-1-${Date.now()}`,
        fetchedAt: new Date().toISOString(),
      })
      .returning({ id: sourcePosts.id });

    const productName = `自己更新商品-${Date.now()}`;
    const first = toLotteryRow(sp.id, makeLottery({ productNameRaw: productName, storeNameRaw: "テスト店" }));
    const result1 = await syncLotteriesFromAnalysis(db, sp.id, [first]);
    expect(result1.results[0].matchAction).toBe("new");
    const lotteryId = result1.results[0].lotteryId!;

    // parserVersion更新等による同一投稿の再解析（応募締切が新たに抽出できた想定）
    const second = toLotteryRow(
      sp.id,
      makeLottery({
        productNameRaw: productName,
        storeNameRaw: "テスト店",
        applicationEnd: { at: null, date: "2026-01-15", precision: "date_only", status: "ok" },
      })
    );
    const result2 = await syncLotteriesFromAnalysis(db, sp.id, [second]);
    expect(result2.results[0].matchAction).toBe("own_updated");
    expect(result2.results[0].lotteryId).toBe(lotteryId);

    const rows = await db.select().from(lotteries).where(eq(lotteries.sourcePostId, sp.id));
    expect(rows).toHaveLength(1); // 重複挿入されていない
    expect(rows[0].applicationEndDate).toBe("2026-01-15");
  });

  it("承認済みの自分のlotteryは、同じ投稿の再解析でも一切変更されない（own_confirmed_skipped）", async () => {
    const [sp] = await db
      .insert(sourcePosts)
      .values({
        platform: "x",
        externalPostId: `own-confirmed-${Date.now()}`,
        sourceUrl: "https://x.com/test/own-confirmed",
        bodyRaw: "自己更新（承認済み）テスト",
        contentHash: `hash-own-confirmed-1-${Date.now()}`,
        fetchedAt: new Date().toISOString(),
      })
      .returning({ id: sourcePosts.id });

    const productName = `承認済み自己商品-${Date.now()}`;
    const first = toLotteryRow(sp.id, makeLottery({ productNameRaw: productName, storeNameRaw: "テスト店" }));
    const result1 = await syncLotteriesFromAnalysis(db, sp.id, [first]);
    const lotteryId = result1.results[0].lotteryId!;

    await db
      .update(lotteries)
      .set({ verificationStatus: "approved", approvedBy: "admin", approvedAt: "2026-01-01T00:00:00.000Z" })
      .where(eq(lotteries.id, lotteryId));

    const second = toLotteryRow(
      sp.id,
      makeLottery({
        productNameRaw: productName,
        storeNameRaw: "テスト店",
        applicationEnd: { at: null, date: "2026-02-20", precision: "date_only", status: "ok" },
      })
    );
    const result2 = await syncLotteriesFromAnalysis(db, sp.id, [second]);
    expect(result2.results[0].matchAction).toBe("own_confirmed_skipped");

    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, lotteryId));
    expect(row.verificationStatus).toBe("approved");
    expect(row.applicationEndDate).toBe("2025-12-31"); // 変更されていない（makeLottery既定値）
  });

  it("再解析で候補が0件になっても、既存lotteryは変更されない（旧orphaned化サイクルを廃止）", async () => {
    const [sp] = await db
      .insert(sourcePosts)
      .values({
        platform: "x",
        externalPostId: `no-orphan-${Date.now()}`,
        sourceUrl: "https://x.com/test/no-orphan",
        bodyRaw: "orphaned化廃止テスト",
        contentHash: `hash-no-orphan-1-${Date.now()}`,
        fetchedAt: new Date().toISOString(),
      })
      .returning({ id: sourcePosts.id });

    const candidate = toLotteryRow(sp.id, makeLottery({ productNameRaw: `orphan化廃止商品-${Date.now()}`, storeNameRaw: "テスト店" }));
    const result1 = await syncLotteriesFromAnalysis(db, sp.id, [candidate]);
    const lotteryId = result1.results[0].lotteryId!;

    // 再解析で「抽選情報なし」と判定された想定（candidates=[]）
    await syncLotteriesFromAnalysis(db, sp.id, []);

    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, lotteryId));
    expect(row.lifecycleStatus).toBe("active"); // orphanedにはならない
    expect(row.orphanedAt).toBeNull();
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

  it("POST /internal/jobs/process（resolve_urls）はPhase 11で能動的経路から除外され、常にunsupported_job_typeになる", async () => {
    const res = await post("/internal/jobs/process?type=resolve_urls");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.error).toBe("unsupported_job_type");
  });

  it("POST /internal/jobs/process は認証無しは401", async () => {
    const res = await app.request("/internal/jobs/process?type=resolve_urls", { method: "POST" });
    expect(res.status).toBe(401);
  });
});
