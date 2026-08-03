import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { retryFailedRevenuecatEventsBatch } from "../services/revenuecatEventRetryService.ts";

const DEFAULT_BATCH_LIMIT = 50;

/**
 * 内部API（Bearer認証、既存`/internal/*`と同じ方式）。Cron Trigger（`scheduled`ハンドラ、
 * src/index.ts）と同じ処理をHTTP経由でも呼べるようにする（ローカル動作確認・手動再試行用）。
 * 本番のCron設定（wrangler.tomlの`[triggers]`）や実デプロイは本フェーズでは行わない。
 *
 * POST /internal/revenuecat-events/retry-batch
 */
export function registerRevenuecatEventRetry(app: Hono<AppEnv>): void {
  app.post("/internal/revenuecat-events/retry-batch", async (c) => {
    const token = c.get("env").INGEST_TOKEN;
    const authHeader = c.req.header("Authorization") ?? "";
    if (!token || authHeader !== `Bearer ${token}`) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }

    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number(limitParam) : DEFAULT_BATCH_LIMIT;

    const db = c.get("db");
    const env = c.get("env");
    const result = await retryFailedRevenuecatEventsBatch({
      db,
      config: {
        secretApiKey: env.REVENUECAT_SECRET_API_KEY,
        monthlyProductId: env.REVENUECAT_MONTHLY_PRODUCT_ID,
        lifetimeProductId: env.REVENUECAT_LIFETIME_PRODUCT_ID,
      },
      limit: Number.isFinite(limit) ? limit : DEFAULT_BATCH_LIMIT,
    });

    return c.json({ ok: true, ...result });
  });
}
