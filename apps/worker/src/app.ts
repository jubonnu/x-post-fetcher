import { Hono } from "hono";
import type { CreateDb } from "./db/client.ts";
import type { AppEnv, Env } from "./env.ts";
import { registerIngest } from "./routes/ingest.ts";
import { registerJobs } from "./routes/jobs.ts";
import { registerLotteries } from "./routes/lotteries.ts";
import { registerReview } from "./routes/review.ts";

/**
 * Hono アプリを生成する（Workers / Node 両対応）。
 * DB クライアント生成関数（createDb）を注入することで、ランタイム別（web/node）の
 * libSQL クライアントを差し替え可能にする（Workers バンドルへ Node 実装を持ち込まない）。
 */
export function createApp(createDb: CreateDb) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const nodeEnv = typeof process !== "undefined" && process.env ? process.env : {};
    const env = { ...nodeEnv, ...((c.env as Record<string, unknown>) ?? {}) } as Env;
    c.set("env", env);
    c.set("db", createDb(env));
    await next();
  });

  // ヘルスチェック（公開）
  app.get("/", (c) => c.json({ ok: true, service: "x-post ingest worker", phase: 5 }));

  // 公開 GET API（Phase 5）
  registerLotteries(app);

  // 内部取込API
  registerIngest(app);

  // 内部ジョブ実行API（Phase 4）
  registerJobs(app);

  // 内部管理API（Phase 5: needs_review 管理、再解析）
  registerReview(app);

  return app;
}
