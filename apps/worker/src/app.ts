import { Hono } from "hono";
import type { CreateDb } from "./db/client.ts";
import type { AppEnv, Env } from "./env.ts";
import { adminApiCors } from "./adminAuth/cors.ts";
import { requireAdminAuthConfigured } from "./adminAuth/middleware.ts";
import { requireAuthConfigured } from "./auth/middleware.ts";
import { publicApiCors } from "./publicCors.ts";
import { registerAccountHardDeletionRetry } from "./routes/accountHardDeletionRetry.ts";
import { registerAdminAuth } from "./routes/adminAuth.ts";
import { registerAdminLotteries } from "./routes/adminLotteries.ts";
import { registerAdminLotteryUpdateCandidates } from "./routes/adminLotteryUpdateCandidates.ts";
import { registerAppleRevocationRetry } from "./routes/appleRevocationRetry.ts";
import { registerAuth } from "./routes/auth.ts";
import { registerBillingWebhook } from "./routes/billingWebhook.ts";
import { registerIngest } from "./routes/ingest.ts";
import { registerJobs } from "./routes/jobs.ts";
import { registerLotteries } from "./routes/lotteries.ts";
import { registerMe } from "./routes/me.ts";
import { registerMeChecklists } from "./routes/meChecklists.ts";
import { registerMeEntitlements } from "./routes/meEntitlements.ts";
import { registerMeFavorites } from "./routes/meFavorites.ts";
import { registerMeFollowedProducts } from "./routes/meFollowedProducts.ts";
import { registerMeLotteries } from "./routes/meLotteries.ts";
import { registerMeNotificationPreferences } from "./routes/meNotificationPreferences.ts";
import { registerMeStatistics } from "./routes/meStatistics.ts";
import { registerMeSyncBootstrap } from "./routes/meSyncBootstrap.ts";
import { registerE2eSeed } from "./routes/e2eSeed.ts";
import { registerRevenuecatEventRetry } from "./routes/revenuecatEventRetry.ts";
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
    c.set("requestId", crypto.randomUUID());
    await next();
  });

  // ヘルスチェック（公開）
  app.get("/", (c) => c.json({ ok: true, service: "x-post ingest worker", phase: 5 }));

  // 商品画像の配信（Phase 7、公開・認証不要）。バケット自体は非公開のままWorker経由でのみ読み出す
  // （<Image>タグ等での表示に認証は不要かつ不可能なため、通常の公開GETとして提供する）。
  app.get("/images/:key", async (c) => {
    const bucket = c.get("env").LOTTERY_IMAGES;
    if (!bucket) return c.notFound();

    const object = await bucket.get(c.req.param("key"));
    if (!object) return c.notFound();

    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });

  // 公開GET API（/lotteries系）のみCORSを許可する。/ingest・/internal/* には適用しない。
  app.use("/lotteries", publicApiCors());
  app.use("/lotteries/*", publicApiCors());

  // 公開 GET API（Phase 5）
  registerLotteries(app);

  // 内部取込API
  registerIngest(app);

  // 内部ジョブ実行API（Phase 4）
  registerJobs(app);

  // 内部管理API（Phase 5: needs_review 管理、再解析）
  registerReview(app);

  // E2E（Playwright）テスト専用。E2E_SEED_ENABLED=trueの環境でのみ有効（fail-closed、詳細はファイル参照）。
  registerE2eSeed(app);

  // Apple側トークン失効の再試行（内部API、Cron Triggerからも同じロジックを呼ぶ。Mobile-G2A-Hardening）
  registerAppleRevocationRetry(app);

  // 猶予期間経過後のアカウント物理削除バッチ（内部API、Cron Triggerからも同じロジックを呼ぶ。Mobile-G2A残修正）
  registerAccountHardDeletionRetry(app);

  // RevenueCat Webhook（Mobile-G4）。CardHubのJWT認証(`requireAuth`)は使わず、RevenueCat専用の
  // 認証で保護するため、`requireAuthConfigured`より前・独立した経路として登録する。
  registerBillingWebhook(app);

  // failed_retryableなRevenueCatイベントの再処理（内部API、Cron Triggerからも同じロジックを呼ぶ。
  // Mobile-G4 Hardening、課金公開前Blocker）。
  registerRevenuecatEventRetry(app);

  // 認証・アカウントAPI（Mobile-G2A）。
  // 認証設定が不正/未設定の場合はここで503 AUTH_NOT_CONFIGUREDにし、以降のハンドラへ進ませない。
  // /lotteries・/ingest・/internal/* はこのミドルウェアを経由しないため、認証設定の状態に関わらず稼働を維持する。
  app.use("/auth/*", requireAuthConfigured);
  app.use("/me", requireAuthConfigured);
  app.use("/me/*", requireAuthConfigured);
  registerAuth(app);
  registerMe(app);

  // ユーザーデータ同期基盤（Mobile-G2B-2〜G2B-5）
  registerMeLotteries(app);
  registerMeFavorites(app);
  registerMeFollowedProducts(app);
  registerMeChecklists(app);
  registerMeNotificationPreferences(app);
  registerMeSyncBootstrap(app);

  // RevenueCat premium entitlements（Mobile-G4）
  registerMeEntitlements(app);

  // 統計・分析（Mobile-G6、premium必須）
  registerMeStatistics(app);

  // 管理画面API（Phase 7: 抽選データの確認・承認・却下・編集用webアプリ、別デプロイのCloudflare Pagesから呼ぶ）。
  // モバイル向け認証（Sign in with Apple）とは完全に別系統。認証設定不正なら/admin/*全体を503にする。
  app.use("/admin/*", adminApiCors());
  app.use("/admin/*", requireAdminAuthConfigured);
  registerAdminAuth(app);
  registerAdminLotteries(app);
  registerAdminLotteryUpdateCandidates(app);

  return app;
}
