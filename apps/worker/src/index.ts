import { createApp } from "./app.ts";
import { createDb } from "./db/client.web.ts";
import type { Env } from "./env.ts";
import { retryAppleRevocationBatch } from "./services/appleRevocationService.ts";
import { retryFailedRevenuecatEventsBatch } from "./services/revenuecatEventRetryService.ts";

/**
 * Cloudflare Workers エントリ（Edge）。
 * DB は @libsql/client/web（fetch ベース）を使用し、Node 専用モジュールを含まない。
 * 必要な env（Secrets）: INGEST_TOKEN / TURSO_DATABASE_URL / TURSO_AUTH_TOKEN
 */
const app = createApp(createDb);

/**
 * Cron Trigger（Mobile-G2A-Hardening）。Apple側トークン失効の再試行対象を一括処理する。
 * 個人開発・処理件数が少ない初期段階での第一候補としてCloudflare Cron Triggerを想定しているが、
 * 本フェーズでは `wrangler.toml` の `[triggers]` 設定・実デプロイは行わない
 * （`POST /internal/apple-revocation/retry-batch` で同じロジックを手動/ローカル実行できる）。
 */
async function scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  const db = createDb(env);
  ctx.waitUntil(
    retryAppleRevocationBatch({ db, env })
      .then((result) => {
        console.log(JSON.stringify({ event: "apple_revocation_retry_batch", ...result }));
      })
      .catch((e: unknown) => {
        // バッチ全体を巻き込む例外（DB接続断等）を握りつぶさず記録する。個々のApple呼び出し失敗は
        // performAppleRevocationAttempt内で既に捕捉・記録済みのため、ここに来るのは想定外のエラーのみ。
        console.error(
          JSON.stringify({
            event: "apple_revocation_retry_batch_failed",
            message: e instanceof Error ? e.message : "unknown error",
          })
        );
      })
  );

  // failed_retryableなRevenueCatイベントの再処理（Mobile-G4 Hardening、課金公開前Blocker）。
  ctx.waitUntil(
    retryFailedRevenuecatEventsBatch({
      db,
      config: {
        secretApiKey: env.REVENUECAT_SECRET_API_KEY,
        monthlyProductId: env.REVENUECAT_MONTHLY_PRODUCT_ID,
        lifetimeProductId: env.REVENUECAT_LIFETIME_PRODUCT_ID,
      },
    })
      .then((result) => {
        console.log(JSON.stringify({ event: "revenuecat_event_retry_batch", ...result }));
      })
      .catch((e: unknown) => {
        console.error(
          JSON.stringify({
            event: "revenuecat_event_retry_batch_failed",
            message: e instanceof Error ? e.message : "unknown error",
          })
        );
      })
  );
}

export default { fetch: app.fetch, scheduled };
