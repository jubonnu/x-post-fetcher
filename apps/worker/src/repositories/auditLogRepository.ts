import type { DbOrTx } from "../db/client.ts";
import { auditLogs } from "../db/schema.ts";

export type AuditAction =
  | "login"
  | "logout"
  | "logout_all"
  | "refresh_reuse_detected"
  | "account_deletion_requested"
  | "account_deletion_request_duplicate"
  | "account_deletion_cancelled"
  | "account_deletion_completed";

/**
 * 監査ログを記録する。トークン・パスワード等の機密情報は`detail`に含めないこと
 * （呼び出し側の責任。本関数はそのまま`detailJson`へシリアライズするのみ）。
 */
export async function recordAuditLog(
  db: DbOrTx,
  params: { userId?: number; action: AuditAction; detail?: Record<string, unknown>; ipHash?: string; requestId?: string }
): Promise<void> {
  await db.insert(auditLogs).values({
    userId: params.userId ?? null,
    action: params.action,
    detailJson: params.detail ? JSON.stringify(params.detail) : null,
    ipHash: params.ipHash ?? null,
    requestId: params.requestId ?? null,
  });
}
