import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { dequeueOne, markJobComplete, markJobFailed } from "../repositories/processingJobRepository.ts";
import { resolveLotteryUrls } from "../services/updateLotteryUrls.ts";

const MAX_JOBS_PER_RUN = 10;
const SUPPORTED_JOB_TYPES = ["resolve_urls"] as const;

/**
 * POST /internal/jobs/process?type=resolve_urls
 * 内部ジョブ実行 API（Bearer 認証）。
 * 指定 jobType の pending ジョブを最大 MAX_JOBS_PER_RUN 件処理して結果を返す。
 */
export function registerJobs(app: Hono<AppEnv>): void {
  app.post("/internal/jobs/process", async (c) => {
    const token = c.get("env").INGEST_TOKEN;
    const authHeader = c.req.header("Authorization") ?? "";
    if (!token || authHeader !== `Bearer ${token}`) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }

    const jobType = (c.req.query("type") ?? "resolve_urls") as (typeof SUPPORTED_JOB_TYPES)[number];
    if (!(SUPPORTED_JOB_TYPES as readonly string[]).includes(jobType)) {
      return c.json({ ok: false, error: "unsupported_job_type" }, 400);
    }

    const db = c.get("db");
    let processed = 0;
    let failed = 0;

    for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
      const job = await dequeueOne(db, jobType);
      if (!job) break;

      try {
        if (jobType === "resolve_urls" && job.lotteryId !== null) {
          await resolveLotteryUrls(db, job.lotteryId);
        }
        await markJobComplete(db, job.id);
        processed++;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        await markJobFailed(db, job.id, errMsg, job.attempts, job.maxAttempts);
        failed++;
        console.error(`[jobs] ${jobType} lotteryId=${job.lotteryId} 失敗: ${errMsg}`);
      }
    }

    return c.json({ ok: true, processed, failed });
  });
}
