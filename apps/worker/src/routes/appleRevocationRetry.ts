import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { retryAppleRevocationBatch } from "../services/appleRevocationService.ts";

const DEFAULT_BATCH_LIMIT = 20;

/**
 * 内部API（Bearer認証、既存`/internal/*`と同じ方式）。Cron Trigger（`scheduled`ハンドラ、
 * src/index.ts）と同じ処理をHTTP経由でも呼べるようにする（ローカル動作確認・手動再試行用）。
 * 本番のCron設定（wrangler.tomlの`[triggers]`）や実デプロイは本フェーズでは行わない。
 *
 * POST /internal/apple-revocation/retry-batch
 */
export function registerAppleRevocationRetry(app: Hono<AppEnv>): void {
  app.post("/internal/apple-revocation/retry-batch", async (c) => {
    const token = c.get("env").INGEST_TOKEN;
    const authHeader = c.req.header("Authorization") ?? "";
    if (!token || authHeader !== `Bearer ${token}`) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }

    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number(limitParam) : DEFAULT_BATCH_LIMIT;

    const db = c.get("db");
    const env = c.get("env");
    const result = await retryAppleRevocationBatch({ db, env, limit: Number.isFinite(limit) ? limit : DEFAULT_BATCH_LIMIT });

    return c.json({ ok: true, ...result });
  });
}
