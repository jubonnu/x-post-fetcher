import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { DbOrTx } from "../db/client.ts";
import { userLotteries, userLotteryStatusHistory, type UserLotteryRow } from "../db/schema.ts";
import { isValidTransition, type LotteryStatus } from "../services/lotteryStatusTransitions.ts";
import { createDefaultChecklistSteps } from "../services/checklistDefaults.ts";

export class InvalidStatusTransitionError extends Error {
  from: LotteryStatus;
  to: LotteryStatus;
  constructor(from: LotteryStatus, to: LotteryStatus) {
    super(`状態遷移が許可されていません: ${from} → ${to}`);
    this.name = "InvalidStatusTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** `expectedServerVersion`が現在のサーバー側`serverVersion`と一致しない（楽観的ロック競合）。 */
export class VersionConflictError extends Error {
  current: UserLotteryRow;
  constructor(current: UserLotteryRow) {
    super("serverVersionが一致しません（他の更新と競合しています）");
    this.name = "VersionConflictError";
    this.current = current;
  }
}

async function insertStatusHistory(
  db: DbOrTx,
  params: { userLotteryId: number; fromStatus: string | null; toStatus: string; source: "user" | "sync_merge" }
): Promise<void> {
  await db.insert(userLotteryStatusHistory).values({
    userLotteryId: params.userLotteryId,
    fromStatus: params.fromStatus,
    toStatus: params.toStatus,
    source: params.source,
  });
}

export async function findUserLottery(db: DbOrTx, userId: number, lotteryId: number): Promise<UserLotteryRow | null> {
  const rows = await db
    .select()
    .from(userLotteries)
    .where(and(eq(userLotteries.userId, userId), eq(userLotteries.lotteryId, lotteryId), isNull(userLotteries.deletedAt)));
  return rows[0] ?? null;
}

/** 論理削除済み行も含めて検索する（復元判定用）。 */
export async function findUserLotteryIncludingDeleted(db: DbOrTx, userId: number, lotteryId: number): Promise<UserLotteryRow | null> {
  const rows = await db
    .select()
    .from(userLotteries)
    .where(and(eq(userLotteries.userId, userId), eq(userLotteries.lotteryId, lotteryId)));
  return rows[0] ?? null;
}

export interface ListUserLotteriesOptions {
  status?: LotteryStatus;
  limit?: number;
  offset?: number;
}

export async function listUserLotteries(
  db: DbOrTx,
  userId: number,
  opts: ListUserLotteriesOptions = {}
): Promise<{ items: UserLotteryRow[]; total: number }> {
  const { status, limit = 20, offset = 0 } = opts;
  const conditions = [eq(userLotteries.userId, userId), isNull(userLotteries.deletedAt), ...(status ? [eq(userLotteries.status, status)] : [])];
  const where = and(...conditions);

  const [items, [{ total }]] = await Promise.all([
    db.select().from(userLotteries).where(where).orderBy(desc(userLotteries.updatedAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(userLotteries).where(where),
  ]);

  return { items, total };
}

export interface UpsertUserLotteryParams {
  userId: number;
  lotteryId: number;
  status?: LotteryStatus;
  snapshotJson?: string | null;
  savedAt?: string;
  expectedServerVersion?: number;
}

export type UpsertUserLotteryOutcome = "created" | "restored" | "updated";

export interface UpsertUserLotteryResult {
  row: UserLotteryRow;
  outcome: UpsertUserLotteryOutcome;
}

/**
 * `PUT /me/lotteries/:lotteryId` / `PATCH /me/lotteries/:lotteryId` の共通ロジック
 * （Mobile-G2B-2、G2B-Hardeningで冪等性判定を`idempotency_records`台帳へ分離した「純粋な」
 * CAS操作。呼び出し側（ルート層）が`services/idempotencyLedger.ts`の`runIdempotent`で
 * 台帳確認・本関数呼び出し・台帳記録を単一トランザクションにまとめる）。
 *
 * 新規作成・論理削除からの復元・通常更新のいずれも扱う。
 * 復元は必ず既存行の`deletedAt`を戻す形で行い、新規行を作らない（行IDを維持する）。
 * 楽観的ロック: 既存の有効行を更新する場合のみ`expectedServerVersion`のCASを要求する
 * （新規作成・削除済みからの復元には要求しない）。
 */
export async function upsertUserLottery(db: DbOrTx, params: UpsertUserLotteryParams): Promise<UpsertUserLotteryResult> {
  const now = new Date().toISOString();
  const existing = await findUserLotteryIncludingDeleted(db, params.userId, params.lotteryId);

  if (!existing) {
    const initialStatus: LotteryStatus = params.status ?? "unknown";
    // user_lotteries作成・状態履歴・デフォルトチェックリストステップ生成を単一トランザクションで
    // 行う（Mobile-G2B-4: 計画書「自分の抽選保存時に同一トランザクションで生成」の第一候補方針）。
    // `db`が既に（呼び出し元`runIdempotent`が開いた）トランザクションの場合、
    // `.transaction()`はSAVEPOINTとしてネストされる（drizzle-orm/libsqlで確認済み）。
    const row = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(userLotteries)
        .values({
          userId: params.userId,
          lotteryId: params.lotteryId,
          status: initialStatus,
          snapshotJson: params.snapshotJson ?? null,
          snapshotUpdatedAt: params.snapshotJson !== undefined ? now : null,
          savedAt: params.savedAt ?? now,
          serverVersion: 1,
        })
        .returning();
      await insertStatusHistory(tx, { userLotteryId: inserted.id, fromStatus: null, toStatus: initialStatus, source: "user" });
      await createDefaultChecklistSteps(tx, { userId: params.userId, lotteryId: params.lotteryId });
      return inserted;
    });
    return { row, outcome: "created" };
  }

  const isRestore = existing.deletedAt !== null;
  const nextStatus: LotteryStatus = (params.status ?? existing.status) as LotteryStatus;

  if (!isRestore && params.status !== undefined && params.status !== existing.status) {
    if (!isValidTransition(existing.status as LotteryStatus, params.status)) {
      throw new InvalidStatusTransitionError(existing.status as LotteryStatus, params.status);
    }
  }

  if (!isRestore) {
    // 通常更新: CAS必須。
    const conditions = [eq(userLotteries.id, existing.id), eq(userLotteries.serverVersion, params.expectedServerVersion ?? -1)];
    const [updated] = await db
      .update(userLotteries)
      .set({
        status: nextStatus,
        ...(params.snapshotJson !== undefined ? { snapshotJson: params.snapshotJson, snapshotUpdatedAt: now } : {}),
        serverVersion: existing.serverVersion + 1,
        updatedAt: now,
      })
      .where(and(...conditions))
      .returning();

    if (!updated) {
      const [current] = await db.select().from(userLotteries).where(eq(userLotteries.id, existing.id));
      throw new VersionConflictError(current);
    }

    if (nextStatus !== existing.status) {
      await insertStatusHistory(db, { userLotteryId: updated.id, fromStatus: existing.status, toStatus: nextStatus, source: "user" });
    }
    return { row: updated, outcome: "updated" };
  }

  // 復元: 削除済み行を再利用する（新規行を追加しない、行IDを維持する）。
  const [restored] = await db
    .update(userLotteries)
    .set({
      status: nextStatus,
      ...(params.snapshotJson !== undefined ? { snapshotJson: params.snapshotJson, snapshotUpdatedAt: now } : {}),
      savedAt: params.savedAt ?? now,
      serverVersion: existing.serverVersion + 1,
      deletedAt: null,
      updatedAt: now,
    })
    .where(eq(userLotteries.id, existing.id))
    .returning();

  if (nextStatus !== existing.status) {
    await insertStatusHistory(db, { userLotteryId: restored.id, fromStatus: existing.status, toStatus: nextStatus, source: "user" });
  }
  return { row: restored, outcome: "restored" };
}

export interface SoftDeleteResult {
  alreadyDeleted: boolean;
  row: UserLotteryRow | null;
}

/** 論理削除。冪等（既に削除済みでも成功として扱う）。純粋なCAS操作（冪等性判定は呼び出し側の台帳が行う）。 */
export async function softDeleteUserLottery(
  db: DbOrTx,
  params: { userId: number; lotteryId: number; expectedServerVersion?: number }
): Promise<SoftDeleteResult> {
  const existing = await findUserLotteryIncludingDeleted(db, params.userId, params.lotteryId);
  if (!existing) return { alreadyDeleted: false, row: null };
  if (existing.deletedAt) return { alreadyDeleted: true, row: existing };

  const now = new Date().toISOString();
  const [updated] = await db
    .update(userLotteries)
    .set({ deletedAt: now, updatedAt: now, serverVersion: existing.serverVersion + 1 })
    .where(and(eq(userLotteries.id, existing.id), eq(userLotteries.serverVersion, params.expectedServerVersion ?? existing.serverVersion)))
    .returning();

  if (!updated) {
    const [current] = await db.select().from(userLotteries).where(eq(userLotteries.id, existing.id));
    if (current?.deletedAt) return { alreadyDeleted: true, row: current };
    throw new VersionConflictError(current);
  }

  return { alreadyDeleted: false, row: updated };
}

export interface SyncLotteryItem {
  lotteryId: number;
  status: LotteryStatus;
  savedAt?: string;
  snapshotJson?: string | null;
}

export interface SyncMergedItem {
  lotteryId: number;
  status: string;
  serverVersion: number;
  savedAt: string;
  updatedAt: string;
}

export interface SyncConflictItem {
  lotteryId: number;
  resolvedStatus: string;
  reason: "server_already_had_data" | "server_already_deleted" | "idempotency_conflict";
}

/**
 * `POST /me/lotteries/sync`・bootstrap同期の1アイテム分のマージ判定
 * （Mobile-G2B-2、G2B-Hardeningで冪等性判定を呼び出し側の台帳へ分離）。
 *
 * クライアントは`expectedServerVersion`を持たない（サーバーに一度も同期していないローカル
 * データのため）。よって「新規`lotteryId`は無条件で採用」「既存の有効行が既にあれば
 * 上書きせず`conflicts`として報告する」という保守的な方針を取る。
 * 論理削除済みの行への自動復元も行わない（意図的な削除を初回同期で覆さないため）。
 */
export async function mergeSyncLotteryItem(
  db: DbOrTx,
  userId: number,
  item: SyncLotteryItem
): Promise<{ merged?: SyncMergedItem; conflict?: SyncConflictItem }> {
  const existing = await findUserLotteryIncludingDeleted(db, userId, item.lotteryId);

  if (!existing) {
    const { row } = await upsertUserLottery(db, {
      userId,
      lotteryId: item.lotteryId,
      status: item.status,
      snapshotJson: item.snapshotJson,
      savedAt: item.savedAt,
    });
    return { merged: { lotteryId: item.lotteryId, status: row.status, serverVersion: row.serverVersion, savedAt: row.savedAt, updatedAt: row.updatedAt } };
  }

  if (existing.deletedAt) {
    return { conflict: { lotteryId: item.lotteryId, resolvedStatus: existing.status, reason: "server_already_deleted" } };
  }

  return { conflict: { lotteryId: item.lotteryId, resolvedStatus: existing.status, reason: "server_already_had_data" } };
}
