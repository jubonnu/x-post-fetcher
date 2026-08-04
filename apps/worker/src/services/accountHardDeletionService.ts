import type { Db } from "../db/client.ts";
import { findAccountHardDeletionTargets, hardDeleteUserAccount } from "../repositories/accountDeletionRepository.ts";

export interface AccountHardDeletionBatchResult {
  processed: number;
  deleted: number;
  skipped: number;
}

/**
 * 猶予期間（`scheduledDeletionAt`）を過ぎたアカウントを一括で物理削除する（Mobile-G2A残修正）。
 * Apple側トークン失効の再試行バッチ（`appleRevocationService.ts`）と同じ構成: Cron Trigger
 * （`src/index.ts`の`scheduled`）と内部HTTP API（`routes/accountHardDeletionRetry.ts`）の
 * 両方から同じロジックを呼べるようにする。
 */
export async function runAccountHardDeletionBatch(params: {
  db: Db;
  limit?: number;
}): Promise<AccountHardDeletionBatchResult> {
  const { db, limit } = params;
  const targets = await findAccountHardDeletionTargets(db, { limit });

  const result: AccountHardDeletionBatchResult = { processed: 0, deleted: 0, skipped: 0 };

  for (const target of targets) {
    result.processed += 1;
    const outcome = await hardDeleteUserAccount(db, { requestId: target.id, userId: target.userId });
    if (outcome.deleted) result.deleted += 1;
    else result.skipped += 1;
  }

  return result;
}
