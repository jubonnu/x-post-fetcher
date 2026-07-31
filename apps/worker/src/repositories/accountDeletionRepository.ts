import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { accountDeletionRequests, users, type AccountDeletionRequestRow } from "../db/schema.ts";
import { APPLE_REVOCATION_MAX_ATTEMPTS, computeNextRetryAt } from "../services/appleRevocationBackoff.ts";

export interface AccountDeletionResult {
  requestId: number;
  scheduledDeletionAt: string;
  alreadyRequested: boolean;
  appleRevocationStatus: string;
}

/**
 * アカウント削除要求（`DELETE /me`）。即時物理削除ではなく猶予期間付きの`pending_deletion`へ遷移させる。
 * 同じユーザーからの再送は冪等（既存のpending要求があればそれをそのまま返す、新規行は作らない）。
 * `appleRevocationStatus`が`failed_will_retry`のままの場合、再送のたびにApple側失効の再試行対象になる
 * （呼び出し側`routes/me.ts`が`shouldAttemptAppleRevocation`で判定する）。
 */
export async function requestAccountDeletion(
  db: Db,
  params: { userId: number; graceDays: number }
): Promise<AccountDeletionResult> {
  const existingPending = await db
    .select()
    .from(accountDeletionRequests)
    .where(and(eq(accountDeletionRequests.userId, params.userId), eq(accountDeletionRequests.status, "pending")))
    .orderBy(desc(accountDeletionRequests.requestedAt))
    .limit(1);

  if (existingPending[0]) {
    return {
      requestId: existingPending[0].id,
      scheduledDeletionAt: existingPending[0].scheduledDeletionAt,
      alreadyRequested: true,
      appleRevocationStatus: existingPending[0].appleRevocationStatus,
    };
  }

  const now = new Date();
  const scheduledDeletionAt = new Date(now.getTime() + params.graceDays * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = now.toISOString();

  const [inserted] = await db
    .insert(accountDeletionRequests)
    .values({
      userId: params.userId,
      requestedAt: nowIso,
      scheduledDeletionAt,
      status: "pending",
    })
    .returning();

  await db
    .update(users)
    .set({
      accountStatus: "pending_deletion",
      deletionRequestedAt: nowIso,
      scheduledDeletionAt,
      updatedAt: nowIso,
    })
    .where(eq(users.id, params.userId));

  return {
    requestId: inserted.id,
    scheduledDeletionAt,
    alreadyRequested: false,
    appleRevocationStatus: inserted.appleRevocationStatus,
  };
}

/**
 * クレームID（フェンシングトークン）が指定された場合、`WHERE claimId = 指定値`も条件に含める。
 * stale判定で別Workerに再クレームされた後、古いWorkerが遅れて完了報告してもこの条件が
 * 一致しなくなるため、UPDATEが0件（=フェンスされた）になり新しい処理結果を上書きしない。
 * Cronリトライ経由以外（`DELETE /me`の即時試行等、クレームの概念が無い呼び出し元）は
 * `claimId`を省略でき、その場合は従来通り無条件（id一致のみ）で更新する。
 */
function withClaimCondition(requestId: number, claimId?: string) {
  return claimId
    ? and(eq(accountDeletionRequests.id, requestId), eq(accountDeletionRequests.appleRevocationClaimId, claimId))
    : eq(accountDeletionRequests.id, requestId);
}

/** Apple識別子・Apple Refresh Token自体が無く、そもそも失効対象が無い場合。 */
export async function markAppleRevocationNotApplicable(
  db: Db,
  requestId: number,
  options: { claimId?: string } = {}
): Promise<{ fenced: boolean }> {
  const [updated] = await db
    .update(accountDeletionRequests)
    .set({ appleRevocationStatus: "not_applicable" })
    .where(withClaimCondition(requestId, options.claimId))
    .returning();
  return { fenced: !updated };
}

export async function markAppleRevocationSucceeded(
  db: Db,
  requestId: number,
  options: { claimId?: string } = {}
): Promise<{ fenced: boolean }> {
  const [updated] = await db
    .update(accountDeletionRequests)
    .set({
      appleRevocationStatus: "succeeded",
      appleRevocationLastAttemptAt: new Date().toISOString(),
      appleRevocationNextRetryAt: null,
    })
    .where(withClaimCondition(requestId, options.claimId))
    .returning();
  return { fenced: !updated };
}

export interface RecordAppleRevocationFailureResult {
  fenced: boolean;
  status: "failed_will_retry" | "failed_permanently";
  attempts: number;
  nextRetryAt: string | null;
}

/**
 * Apple側失効の試行が失敗した場合の記録。最大試行回数に達したら`failed_permanently`にし、
 * それ以外は`failed_will_retry`にして指数バックオフで次回再試行時刻を設定する。
 * `errorMessage`はApple APIのエラーコード等の非機密情報のみとし、トークン等は含めないこと。
 *
 * `options.claimId`が指定され、かつ書き込み時点でその行のクレームIDが一致しない場合
 * （＝stale判定で別Workerに再クレームされた後）は、`fenced: true`を返し実際には更新しない
 * （retryCountの二重加算・古い結果による上書きを防ぐ）。
 */
export async function recordAppleRevocationFailure(
  db: Db,
  requestId: number,
  errorMessage: string,
  options: { claimId?: string } = {}
): Promise<RecordAppleRevocationFailureResult> {
  const rows = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, requestId));
  const current = rows[0];
  const attempts = (current?.appleRevocationAttempts ?? 0) + 1;
  const permanentlyFailed = attempts >= APPLE_REVOCATION_MAX_ATTEMPTS;
  const status = permanentlyFailed ? "failed_permanently" : "failed_will_retry";
  const nextRetryAt = permanentlyFailed ? null : computeNextRetryAt(attempts);

  const [updated] = await db
    .update(accountDeletionRequests)
    .set({
      appleRevocationStatus: status,
      appleRevocationAttempts: attempts,
      appleRevocationLastAttemptAt: new Date().toISOString(),
      appleRevocationLastError: errorMessage,
      appleRevocationNextRetryAt: nextRetryAt,
    })
    .where(withClaimCondition(requestId, options.claimId))
    .returning();

  return { fenced: !updated, status, attempts, nextRetryAt };
}

/**
 * 再試行してよい状態か。既に成功済み・恒久的に失敗確定済みの場合のみ再試行しない
 * （デフォルト値`not_applicable`は「まだ評価していない」も意味しうるため、
 * 成功/恒久失敗以外は常に試行対象とする。ジャンルが無いケースは呼び出し側が
 * `markAppleRevocationNotApplicable`を明示的に呼んで確定させる）。
 */
export function shouldAttemptAppleRevocation(row: Pick<AccountDeletionRequestRow, "appleRevocationStatus">): boolean {
  return row.appleRevocationStatus !== "succeeded" && row.appleRevocationStatus !== "failed_permanently";
}
