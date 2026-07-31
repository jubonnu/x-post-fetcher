import { and, asc, eq, isNull } from "drizzle-orm";
import type { DbOrTx } from "../db/client.ts";
import { checklistProgress, type ChecklistProgressRow } from "../db/schema.ts";

export class ChecklistVersionConflictError extends Error {
  current: ChecklistProgressRow;
  constructor(current: ChecklistProgressRow) {
    super("serverVersionが一致しません（他の更新と競合しています）");
    this.name = "ChecklistVersionConflictError";
    this.current = current;
  }
}

export async function listChecklistSteps(db: DbOrTx, userId: number, lotteryId: number): Promise<ChecklistProgressRow[]> {
  return db
    .select()
    .from(checklistProgress)
    .where(and(eq(checklistProgress.userId, userId), eq(checklistProgress.lotteryId, lotteryId), isNull(checklistProgress.deletedAt)))
    .orderBy(asc(checklistProgress.sortOrder), asc(checklistProgress.id));
}

export async function findChecklistStep(db: DbOrTx, userId: number, lotteryId: number, stepId: string): Promise<ChecklistProgressRow | null> {
  const rows = await db
    .select()
    .from(checklistProgress)
    .where(
      and(
        eq(checklistProgress.userId, userId),
        eq(checklistProgress.lotteryId, lotteryId),
        eq(checklistProgress.stepId, stepId),
        isNull(checklistProgress.deletedAt)
      )
    );
  return rows[0] ?? null;
}

export async function findChecklistStepIncludingDeleted(db: DbOrTx, userId: number, lotteryId: number, stepId: string): Promise<ChecklistProgressRow | null> {
  const rows = await db
    .select()
    .from(checklistProgress)
    .where(and(eq(checklistProgress.userId, userId), eq(checklistProgress.lotteryId, lotteryId), eq(checklistProgress.stepId, stepId)));
  return rows[0] ?? null;
}

export async function countActiveChecklistSteps(db: DbOrTx, userId: number, lotteryId: number): Promise<number> {
  const rows = await listChecklistSteps(db, userId, lotteryId);
  return rows.length;
}

export interface UpsertChecklistStepParams {
  userId: number;
  lotteryId: number;
  stepId: string;
  label: string;
  done: boolean;
  completedNote?: string | null;
  sortOrder?: number;
  clientActionAt?: string;
  expectedServerVersion: number;
}

/**
 * チェックリスト1ステップのCAS upsert（Mobile-G2B-4）。
 * `done=false`も正規操作として扱い、`completedAt`をnullへ戻す（10章で確定した方針）。
 * `clientActionAt`は保存するが競合判定には一切使わない（`serverVersion`のみで判定する）。
 * 冪等性・「同一clientRequestIdの誤用」検知は呼び出し側（`services/idempotencyLedger.ts`）が
 * 台帳で行うため、ここでは扱わない（純粋なCAS操作のみ）。
 */
export async function upsertChecklistStepRow(db: DbOrTx, params: UpsertChecklistStepParams): Promise<{ row: ChecklistProgressRow; created: boolean }> {
  const now = new Date().toISOString();
  const existing = await findChecklistStepIncludingDeleted(db, params.userId, params.lotteryId, params.stepId);

  if (!existing || existing.deletedAt) {
    // 新規作成、または論理削除済みカスタムステップと同じstepIdでの再作成（通常発生しないが冪等に扱う）。
    if (existing?.deletedAt) {
      const [restored] = await db
        .update(checklistProgress)
        .set({
          label: params.label,
          done: params.done,
          completedAt: params.done ? now : null,
          completedNote: params.completedNote ?? null,
          sortOrder: params.sortOrder ?? existing.sortOrder,
          clientActionAt: params.clientActionAt ?? null,
          serverVersion: existing.serverVersion + 1,
          serverReceivedAt: now,
          updatedAt: now,
          deletedAt: null,
        })
        .where(eq(checklistProgress.id, existing.id))
        .returning();
      return { row: restored, created: false };
    }

    const [row] = await db
      .insert(checklistProgress)
      .values({
        userId: params.userId,
        lotteryId: params.lotteryId,
        stepId: params.stepId,
        label: params.label,
        done: params.done,
        completedAt: params.done ? now : null,
        completedNote: params.completedNote ?? null,
        sortOrder: params.sortOrder ?? 0,
        clientActionAt: params.clientActionAt ?? null,
        serverVersion: 1,
        serverReceivedAt: now,
      })
      .returning();
    return { row, created: true };
  }

  const [updated] = await db
    .update(checklistProgress)
    .set({
      label: params.label,
      done: params.done,
      completedAt: params.done ? now : null,
      completedNote: params.completedNote ?? null,
      sortOrder: params.sortOrder ?? existing.sortOrder,
      clientActionAt: params.clientActionAt ?? null,
      serverVersion: existing.serverVersion + 1,
      serverReceivedAt: now,
      updatedAt: now,
    })
    .where(and(eq(checklistProgress.id, existing.id), eq(checklistProgress.serverVersion, params.expectedServerVersion)))
    .returning();

  if (!updated) {
    const [current] = await db.select().from(checklistProgress).where(eq(checklistProgress.id, existing.id));
    throw new ChecklistVersionConflictError(current);
  }

  return { row: updated, created: false };
}

export type DeleteChecklistStepResult = "deleted" | "already_deleted" | "not_found" | "default_step_forbidden";

/** カスタムステップの論理削除。デフォルトステップ（`default-*`）は削除不可。冪等。 */
export async function softDeleteChecklistStep(
  db: DbOrTx,
  params: { userId: number; lotteryId: number; stepId: string; isDefaultStep: boolean }
): Promise<DeleteChecklistStepResult> {
  const existing = await findChecklistStepIncludingDeleted(db, params.userId, params.lotteryId, params.stepId);
  if (!existing) return "not_found";
  if (params.isDefaultStep) return "default_step_forbidden";
  if (existing.deletedAt) return "already_deleted";

  const now = new Date().toISOString();
  await db
    .update(checklistProgress)
    .set({ deletedAt: now, updatedAt: now, serverVersion: existing.serverVersion + 1 })
    .where(eq(checklistProgress.id, existing.id));
  return "deleted";
}
