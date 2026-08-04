import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { accountDeletionRequests, type AccountDeletionRequestRow } from "../db/schema.ts";

/**
 * Cron再試行の対象を取得する。以下のいずれかを満たす行が対象:
 * - `failed_will_retry`かつ次回再試行時刻を過ぎたもの
 * - `processing`のままstale判定時間を超えて放置されているもの（Workerの強制終了等で
 *   `claimRequestForRetry`後に処理が完了しなかった行。Mobile-G2A残修正）
 */
export async function findAppleRevocationRetryTargets(
  db: Db,
  params: { now?: string; staleThreshold?: string; limit?: number } = {}
): Promise<AccountDeletionRequestRow[]> {
  const now = params.now ?? new Date().toISOString();
  const limit = params.limit ?? 20;

  const dueForRetry = and(
    eq(accountDeletionRequests.appleRevocationStatus, "failed_will_retry"),
    or(
      isNull(accountDeletionRequests.appleRevocationNextRetryAt),
      lte(accountDeletionRequests.appleRevocationNextRetryAt, now)
    )
  );

  const conditions = params.staleThreshold
    ? or(
        dueForRetry,
        and(
          eq(accountDeletionRequests.appleRevocationStatus, "processing"),
          lt(accountDeletionRequests.appleRevocationProcessingStartedAt, params.staleThreshold)
        )
      )
    : dueForRetry;

  return db
    .select()
    .from(accountDeletionRequests)
    .where(
      // 削除要求自体が取り消し済み（再サインインでの取消）・完了済み（ハードデリート済み）の行は、
      // appleRevocationStatusがfailed_will_retryのままでも再試行対象から除外する（Mobile-G2A残修正）。
      // これが無いと、取消済み＝現在アクティブなアカウントに対してApple側トークン失効を
      // 誤って実行してしまう。
      and(eq(accountDeletionRequests.status, "pending"), conditions)
    )
    .orderBy(asc(accountDeletionRequests.appleRevocationNextRetryAt))
    .limit(limit);
}

export interface ClaimedRetryTarget {
  row: AccountDeletionRequestRow;
  claimId: string;
}

/**
 * 再試行対象を条件付きUPDATEでクレームする（二重処理防止・stale回収の両方に対応）。
 *
 * クレーム対象の条件（`WHERE`）: `failed_will_retry`、または`processing`かつ
 * `processingStartedAt`がstale閾値より前（＝取り残された行）。
 * クレーム時に`appleRevocationClaimId`をランダムUUIDへ更新することで「フェンシングトークン」
 * とする。以降の処理結果の書き込みは必ずこの`claimId`と一致する場合のみ有効にする
 * （`accountDeletionRepository.ts`の各`mark*`/`record*`関数を参照）。これにより、
 * stale判定で別Workerに再クレームされた後、古いWorkerが遅れて完了報告しても
 * 新しい処理結果を上書きしない。
 *
 * 条件付きUPDATEのため、同時に複数の呼び出しが同じ行を処理しようとしても、
 * 実際に行を更新できるのは1つだけになる（SQLite/libSQLの同一行への書き込み直列化に依存。
 * refresh_tokensのローテーションで使った手法と同じ）。クレームに失敗した場合は`null`を返し、
 * 呼び出し側はスキップする（エラーにはしない）。
 */
export async function claimRequestForRetry(
  db: Db,
  requestId: number,
  staleThreshold: string
): Promise<ClaimedRetryTarget | null> {
  const claimId = crypto.randomUUID();
  const now = new Date().toISOString();

  const [claimed] = await db
    .update(accountDeletionRequests)
    .set({
      appleRevocationStatus: "processing",
      appleRevocationProcessingStartedAt: now,
      appleRevocationClaimId: claimId,
    })
    .where(
      and(
        eq(accountDeletionRequests.id, requestId),
        // 取消/完了済みの削除要求はクレームさせない（`findAppleRevocationRetryTargets`と同じ理由）。
        eq(accountDeletionRequests.status, "pending"),
        or(
          eq(accountDeletionRequests.appleRevocationStatus, "failed_will_retry"),
          and(
            eq(accountDeletionRequests.appleRevocationStatus, "processing"),
            lt(accountDeletionRequests.appleRevocationProcessingStartedAt, staleThreshold)
          )
        )
      )
    )
    .returning();

  return claimed ? { row: claimed, claimId } : null;
}
