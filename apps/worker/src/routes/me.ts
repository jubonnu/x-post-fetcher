import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { requireAuth } from "../auth/middleware.ts";
import { apiErrorJson, ApiError } from "../auth/errors.ts";
import { findUserByInternalId } from "../repositories/userRepository.ts";
import { requestAccountDeletion, shouldAttemptAppleRevocation } from "../repositories/accountDeletionRepository.ts";
import { revokeAllForUser } from "../repositories/refreshTokenRepository.ts";
import { recordAuditLog } from "../repositories/auditLogRepository.ts";
import { performAppleRevocationAttempt } from "../services/appleRevocationService.ts";

/**
 * Mobile-G2A: GET/DELETE /me。
 * 内部integer `id` はレスポンスへ一切含めない（`publicUserId`のみ返す）。
 */
export function registerMe(app: Hono<AppEnv>): void {
  app.get("/me", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const user = await findUserByInternalId(db, userId);
    if (!user) {
      return apiErrorJson(c, new ApiError("NOT_FOUND", "ユーザーが見つかりません"));
    }

    return c.json({
      publicUserId: user.publicUserId,
      displayName: user.displayName,
      email: user.email,
      accountStatus: user.accountStatus,
      scheduledDeletionAt: user.scheduledDeletionAt,
      createdAt: user.createdAt,
    });
  });

  app.delete("/me", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const authConfig = c.get("authConfig")!;

    const result = await requestAccountDeletion(db, { userId, graceDays: authConfig.accountDeletionGraceDays });

    if (!result.alreadyRequested) {
      // 削除要求と同時に全端末のセッションを失効させる（要件反映）
      await revokeAllForUser(db, userId, "account_deleted");
    }

    // Apple側トークン失効はベストエフォート（CardHub側の削除は上記で既に完了している）。
    // 既に成功済み・恒久的に失敗確定済みならスキップする（`shouldAttemptAppleRevocation`）。
    // 一時的な失敗は`failed_will_retry`として記録され、Cron再試行ジョブまたは
    // 本リクエストの再送（冪等）で再試行される。
    if (shouldAttemptAppleRevocation(result)) {
      await performAppleRevocationAttempt({ db, env: c.get("env"), userId, requestId: result.requestId });
    }

    await recordAuditLog(db, {
      userId,
      action: result.alreadyRequested ? "account_deletion_request_duplicate" : "account_deletion_requested",
      detail: { scheduledDeletionAt: result.scheduledDeletionAt },
      requestId: c.get("requestId"),
    });

    return c.json({ ok: true, scheduledDeletionAt: result.scheduledDeletionAt });
  });
}
