import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { runAccountHardDeletionBatch } from "../services/accountHardDeletionService.ts";

const DEFAULT_BATCH_LIMIT = 20;

/**
 * 内部API（Bearer認証、既存`/internal/*`と同じ方式）。Cron Trigger（`scheduled`ハンドラ、
 * src/index.ts）と同じ処理をHTTP経由でも呼べるようにする（ローカル動作確認・手動実行用、
 * `routes/appleRevocationRetry.ts`と同じ構成、Mobile-G2A残修正）。
 *
 * POST /internal/account-hard-deletion/retry-batch
 */
export function registerAccountHardDeletionRetry(app: Hono<AppEnv>): void {
  app.post("/internal/account-hard-deletion/retry-batch", async (c) => {
    const token = c.get("env").INGEST_TOKEN;
    const authHeader = c.req.header("Authorization") ?? "";
    if (!token || authHeader !== `Bearer ${token}`) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }

    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number(limitParam) : DEFAULT_BATCH_LIMIT;

    const db = c.get("db");
    const result = await runAccountHardDeletionBatch({ db, limit: Number.isFinite(limit) ? limit : DEFAULT_BATCH_LIMIT });

    return c.json({ ok: true, ...result });
  });
}
