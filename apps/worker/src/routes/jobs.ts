import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { processingJobs, sourcePosts } from "../db/schema.ts";
import { dequeueOne, markJobComplete, markJobFailed } from "../repositories/processingJobRepository.ts";
import { resolveLotteryUrls } from "../services/updateLotteryUrls.ts";

const MAX_JOBS_PER_RUN = 10;

/**
 * 内部ジョブ管理 API（Bearer 認証）。
 *
 * POST /internal/jobs/process?type=resolve_urls   — 既存バッチ処理
 * GET  /internal/jobs/next?type=analyze_post       — 1件デキュー（スクレイパー向け）
 * POST /internal/jobs/:id/complete                 — 完了報告
 * POST /internal/jobs/:id/fail                     — 失敗報告
 */
export function registerJobs(app: Hono<AppEnv>): void {
  // ----- 既存: resolve_urls バッチ処理 -----
  app.post("/internal/jobs/process", async (c) => {
    const token = c.get("env").INGEST_TOKEN;
    const authHeader = c.req.header("Authorization") ?? "";
    if (!token || authHeader !== `Bearer ${token}`) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }

    const jobType = c.req.query("type") ?? "resolve_urls";
    if (jobType !== "resolve_urls") {
      return c.json({ ok: false, error: "unsupported_job_type" }, 400);
    }

    const db = c.get("db");
    let processed = 0;
    let failed = 0;

    for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
      const job = await dequeueOne(db, "resolve_urls");
      if (!job) break;

      try {
        if (job.lotteryId !== null) {
          await resolveLotteryUrls(db, job.lotteryId);
        }
        await markJobComplete(db, job.id);
        processed++;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        await markJobFailed(db, job.id, errMsg, job.attempts, job.maxAttempts);
        failed++;
        console.error(`[jobs] resolve_urls lotteryId=${job.lotteryId} 失敗: ${errMsg}`);
      }
    }

    return c.json({ ok: true, processed, failed });
  });

  // ----- analyze_post ジョブ: スクレイパー向けデキュー -----
  app.get("/internal/jobs/next", async (c) => {
    const token = c.get("env").INGEST_TOKEN;
    const authHeader = c.req.header("Authorization") ?? "";
    if (!token || authHeader !== `Bearer ${token}`) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }

    const jobType = c.req.query("type") ?? "analyze_post";
    if (jobType !== "analyze_post") {
      return c.json({ ok: false, error: "unsupported_job_type" }, 400);
    }

    const db = c.get("db");
    const job = await dequeueOne(db, "analyze_post");
    if (!job) return c.json({ ok: true, job: null });

    let sourcePost: Record<string, unknown> | null = null;
    if (job.sourcePostId !== null) {
      const rows = await db
        .select({
          id: sourcePosts.id,
          externalPostId: sourcePosts.externalPostId,
          bodyRaw: sourcePosts.bodyRaw,
          publishedAt: sourcePosts.publishedAt,
          externalUrls: sourcePosts.externalUrls,
          imageUrls: sourcePosts.imageUrls,
          sourceUrl: sourcePosts.sourceUrl,
          contentHash: sourcePosts.contentHash,
        })
        .from(sourcePosts)
        .where(eq(sourcePosts.id, job.sourcePostId));

      if (rows.length > 0) {
        const row = rows[0];
        sourcePost = {
          ...row,
          externalUrls: row.externalUrls ? JSON.parse(row.externalUrls) : [],
          imageUrls: row.imageUrls ? JSON.parse(row.imageUrls) : [],
        };
      }
    }

    return c.json({
      ok: true,
      job: {
        jobId: job.id,
        jobType: job.jobType,
        sourcePostId: job.sourcePostId,
        sourcePost,
        parserVersion: process.env.PARSER_VERSION ?? "1",
      },
    });
  });

  // ----- 完了報告 -----
  app.post("/internal/jobs/:id/complete", async (c) => {
    const token = c.get("env").INGEST_TOKEN;
    const authHeader = c.req.header("Authorization") ?? "";
    if (!token || authHeader !== `Bearer ${token}`) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }

    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: "invalid_id" }, 400);

    const db = c.get("db");
    await markJobComplete(db, id);
    return c.json({ ok: true, jobId: id });
  });

  // ----- 失敗報告 -----
  app.post("/internal/jobs/:id/fail", async (c) => {
    const token = c.get("env").INGEST_TOKEN;
    const authHeader = c.req.header("Authorization") ?? "";
    if (!token || authHeader !== `Bearer ${token}`) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }

    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: "invalid_id" }, 400);

    let body: { error?: string } = {};
    try {
      body = (await c.req.json().catch(() => ({}))) as typeof body;
    } catch {
      // 不正なJSON/空bodyは許容する（このエンドポイントの全フィールドが任意項目のため、パース失敗時は空objectのまま続行する）
    }

    const db = c.get("db");
    const rows = await db
      .select({ attempts: processingJobs.attempts, maxAttempts: processingJobs.maxAttempts })
      .from(processingJobs)
      .where(eq(processingJobs.id, id));

    if (rows.length === 0) return c.json({ ok: false, error: "not_found" }, 404);

    const { attempts, maxAttempts } = rows[0];
    await markJobFailed(db, id, body.error ?? "unknown", attempts, maxAttempts);
    return c.json({ ok: true, jobId: id });
  });
}
