import { and, asc, desc, eq, isNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  accountDeletionRequests,
  checklistProgress,
  followedProducts,
  idempotencyRecords,
  notificationPreferences,
  refreshTokens,
  subscriptionEntitlements,
  userFavorites,
  userIdentities,
  userLotteries,
  users,
  type AccountDeletionRequestRow,
} from "../db/schema.ts";
import { APPLE_REVOCATION_MAX_ATTEMPTS, computeNextRetryAt } from "../services/appleRevocationBackoff.ts";
import { recordAuditLog } from "./auditLogRepository.ts";

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
 * `pending_deletion`のユーザーが再サインインした場合に、削除要求を取り消す
 * （アプリ内の案内文「それまでは再度サインインすると取り消せます」を実際に実装する）。
 * `pending`状態のaccount_deletion_requests行が無ければ何もしない（既に取消/完了済み、
 * またはそもそも削除要求が無かった場合。呼び出し側`routes/auth.ts`は
 * `users.accountStatus === "pending_deletion"`の場合のみ呼ぶため通常は存在するはずだが、
 * ハードデリートバッチと競合した場合は0件になり得る＝その場合は取消ではなく新規ユーザー扱いになる）。
 * Apple側トークン失効の状態（`appleRevocationStatus`等）はこの行に残ったままにする
 * （`findAppleRevocationRetryTargets`が`status`列も見るため、cancelled行はCron再試行対象から外れる）。
 */
export async function cancelPendingAccountDeletion(db: Db, userId: number): Promise<{ cancelled: boolean }> {
  const now = new Date().toISOString();

  return db.transaction(async (tx) => {
    const [cancelledRequest] = await tx
      .update(accountDeletionRequests)
      .set({ status: "cancelled", cancelledAt: now, reason: "signed_in_again" })
      .where(and(eq(accountDeletionRequests.userId, userId), eq(accountDeletionRequests.status, "pending")))
      .returning();

    if (!cancelledRequest) {
      return { cancelled: false };
    }

    await tx
      .update(users)
      .set({ accountStatus: "active", deletionRequestedAt: null, scheduledDeletionAt: null, updatedAt: now })
      .where(eq(users.id, userId));

    await recordAuditLog(tx, {
      userId,
      action: "account_deletion_cancelled",
      detail: { requestId: cancelledRequest.id },
    });

    return { cancelled: true };
  });
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

/**
 * 猶予期間（`scheduledDeletionAt`）を過ぎた物理削除バッチの対象を取得する。
 * `status = "pending"`のみを対象にするため、`cancelPendingAccountDeletion`で取り消された
 * 行やハードデリート完了済みの行は自然に除外される。
 */
export async function findAccountHardDeletionTargets(
  db: Db,
  params: { now?: string; limit?: number } = {}
): Promise<AccountDeletionRequestRow[]> {
  const now = params.now ?? new Date().toISOString();
  const limit = params.limit ?? 20;

  return db
    .select()
    .from(accountDeletionRequests)
    .where(and(eq(accountDeletionRequests.status, "pending"), lte(accountDeletionRequests.scheduledDeletionAt, now)))
    .orderBy(asc(accountDeletionRequests.scheduledDeletionAt))
    .limit(limit);
}

/**
 * 猶予期間経過後の物理削除本体。単一のDBトランザクションで実行する（Mobile-G2A残修正）。
 *
 * 冒頭の条件付きUPDATE（`WHERE status = "pending"`）がクレーム兼フェンシングを兼ねる。
 * これが0件（既にcancelled/completedへ遷移済み＝再サインインでの取消と競合した場合等）なら
 * 即座に`{ deleted: false }`を返し、以降のデータ削除は一切行わない。
 * 途中で例外が発生した場合はトランザクション全体がロールバックされ、`status`は"pending"の
 * ままになる（＝次回バッチ実行時に自動的に再試行される。事後的な"processing"状態は持たない）。
 *
 * データ削除方針:
 * - `user_lotteries`/`user_favorites`/`followed_products`/`checklist_progress`は
 *   既存の論理削除（`deletedAt`）方式に揃える。`user_lottery_status_history`等の
 *   追加型履歴（統計用、物理削除しない設計）が参照する行を残さないため。
 * - Apple識別子・暗号化トークン（`user_identities`）、Refresh Token、通知設定、
 *   RevenueCat購読状態、冪等性台帳は、他の行から参照されないPII/認証情報のため物理削除する。
 * - `audit_logs`（userId参照）は監査目的で物理削除しないため、`users`行自体は残し
 *   PIIのみ消去して`accountStatus = "deleted"`にする。
 */
export async function hardDeleteUserAccount(
  db: Db,
  params: { requestId: number; userId: number }
): Promise<{ deleted: boolean }> {
  const { requestId, userId } = params;
  const now = new Date().toISOString();

  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(accountDeletionRequests)
      .set({ status: "completed", completedAt: now })
      .where(and(eq(accountDeletionRequests.id, requestId), eq(accountDeletionRequests.status, "pending")))
      .returning();

    if (!claimed) {
      return { deleted: false };
    }

    await tx
      .update(userLotteries)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(userLotteries.userId, userId), isNull(userLotteries.deletedAt)));
    await tx
      .update(userFavorites)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(userFavorites.userId, userId), isNull(userFavorites.deletedAt)));
    await tx
      .update(followedProducts)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(followedProducts.userId, userId), isNull(followedProducts.deletedAt)));
    await tx
      .update(checklistProgress)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(checklistProgress.userId, userId), isNull(checklistProgress.deletedAt)));

    await tx.delete(notificationPreferences).where(eq(notificationPreferences.userId, userId));
    await tx.delete(subscriptionEntitlements).where(eq(subscriptionEntitlements.userId, userId));
    await tx.delete(idempotencyRecords).where(eq(idempotencyRecords.userId, userId));
    await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
    await tx.delete(userIdentities).where(eq(userIdentities.userId, userId));

    await tx
      .update(users)
      .set({
        accountStatus: "deleted",
        displayName: null,
        email: null,
        emailIsPrivateRelay: null,
        deletedAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, userId));

    await recordAuditLog(tx, {
      userId,
      action: "account_deletion_completed",
      detail: { requestId },
    });

    return { deleted: true };
  });
}
