import type { DbOrTx } from "../db/client.ts";
import { checklistProgress } from "../db/schema.ts";
import { isUniqueConstraintViolation } from "../repositories/userRepository.ts";

/**
 * `apps/mobile/stores/checklistStore.ts`の`DEFAULT_STEP_LABELS`と完全に一致させる
 * （モバイル側のローカル実装が生成していたデフォルトステップと同一のID・ラベルにするため、
 * Mobile-G2Bのモバイル同期実装フェーズでの表示差異を防ぐ）。
 * stepIdは安定した`default-<index>`固定形式とし、端末ごとに別IDを生成しない。
 */
export const DEFAULT_CHECKLIST_STEP_LABELS = ["応募条件を確認", "応募を完了する", "当選結果を確認", "購入手続きをする", "受け取り・開封記録"];

export function defaultChecklistStepId(index: number): string {
  return `default-${index}`;
}

export function isDefaultChecklistStepId(stepId: string): boolean {
  return /^default-\d+$/.test(stepId);
}

/**
 * `user_lotteries`が新規作成された時点で、同一トランザクション内でデフォルトの
 * チェックリストステップを生成する（Mobile-G2B-4、計画書の「第一候補」方針）。
 * 既に存在する場合（理論上到達しないが、念のため）は個別にスキップする冪等実装。
 */
export async function createDefaultChecklistSteps(db: DbOrTx, params: { userId: number; lotteryId: number }): Promise<void> {
  for (const [index, label] of DEFAULT_CHECKLIST_STEP_LABELS.entries()) {
    try {
      await db.insert(checklistProgress).values({
        userId: params.userId,
        lotteryId: params.lotteryId,
        stepId: defaultChecklistStepId(index),
        label,
        sortOrder: index,
      });
    } catch (e) {
      if (!isUniqueConstraintViolation(e)) throw e;
    }
  }
}
