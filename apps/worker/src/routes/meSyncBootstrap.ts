import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { requireAuth } from "../auth/middleware.ts";
import { ApiError, apiErrorJson } from "../auth/errors.ts";
import { syncBootstrapRequestSchema } from "../validation/syncSchemas.ts";
import { SYNC_MAX_PAYLOAD_BYTES } from "../validation/limits.ts";
import { IdempotencyConflictError, runIdempotent } from "../services/idempotencyLedger.ts";
import { readSyncBootstrapServerState, runSyncBootstrapMutations, type SyncBootstrapMutationResult } from "../services/syncBootstrap.ts";

/**
 * Mobile-G2B統合 / G2B-Hardening: POST /me/sync/bootstrap（初回ログイン時の一括同期）。
 * `batchClientRequestId`単位で冪等性台帳を使い、同一リクエストの再送を安全にする
 * （途中失敗後の再送・同一端末の重複送信に対応。別内容の再送はIDEMPOTENCY_CONFLICT）。
 *
 * ミューテーション（`runSyncBootstrapMutations`）は`runIdempotent`が開く単一トランザクション内で
 * 実行され、台帳記録とデータ更新が同一トランザクションになる。`syncId`と`results`のみを
 * 台帳へキャッシュし、`serverState`は常にコミット後に新鮮に読み出す（再送時も最新状態を返す）。
 */
export function registerMeSyncBootstrap(app: Hono<AppEnv>): void {
  app.post("/me/sync/bootstrap", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;

    const rawText = await c.req.text();
    if (new TextEncoder().encode(rawText).length > SYNC_MAX_PAYLOAD_BYTES) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストボディが上限サイズを超えています"));
    }

    let body: unknown;
    try {
      body = JSON.parse(rawText);
    } catch {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストボディが不正です"));
    }

    const parsed = syncBootstrapRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));
    }

    try {
      const cached = await runIdempotent(
        db,
        { userId, scope: "sync_bootstrap", clientRequestId: parsed.data.batchClientRequestId, requestPayload: parsed.data },
        async (tx) => {
          const results = await runSyncBootstrapMutations(tx, userId, {
            userLotteries: parsed.data.userLotteries,
            favorites: parsed.data.favorites,
            followedProducts: parsed.data.followedProducts,
            legacyFollowedProductKeys: parsed.data.legacyFollowedProductKeys,
            checklistSteps: parsed.data.checklistSteps,
            notificationPreferences: parsed.data.notificationPreferences,
          });
          return { syncId: crypto.randomUUID(), results } satisfies { syncId: string; results: SyncBootstrapMutationResult };
        }
      );

      const touchedLotteryIds = parsed.data.userLotteries.map((i) => i.lotteryId);
      const serverState = await readSyncBootstrapServerState(db, userId, touchedLotteryIds);

      return c.json({ syncId: cached.syncId, results: cached.results, serverState });
    } catch (e) {
      if (e instanceof IdempotencyConflictError) {
        return apiErrorJson(c, new ApiError("IDEMPOTENCY_CONFLICT", "batchClientRequestIdが別内容の一括同期で既に使用されています"));
      }
      throw e;
    }
  });
}
