import { asc, eq } from "drizzle-orm";
import type { DbOrTx } from "../db/client.ts";
import { revenuecatEvents, type RevenuecatEventRow } from "../db/schema.ts";
import { isUniqueConstraintViolation } from "./userRepository.ts";

export async function findRevenuecatEventById(db: DbOrTx, revenueCatEventId: string): Promise<RevenuecatEventRow | null> {
  const rows = await db.select().from(revenuecatEvents).where(eq(revenuecatEvents.revenueCatEventId, revenueCatEventId));
  return rows[0] ?? null;
}

/**
 * `failed_retryable`のまま残っているイベントを古い順に取得する（Mobile-G4 Hardening、
 * 課金公開前Blocker「自動再処理」）。`revenuecatEventRetryService.ts`のCron/内部API経由の
 * バッチ処理から呼ぶ。
 */
export async function findFailedRetryableRevenuecatEvents(db: DbOrTx, limit: number): Promise<RevenuecatEventRow[]> {
  return db
    .select()
    .from(revenuecatEvents)
    .where(eq(revenuecatEvents.processingStatus, "failed_retryable"))
    .orderBy(asc(revenuecatEvents.createdAt))
    .limit(limit);
}

export interface InsertRevenuecatEventParams {
  revenueCatEventId: string;
  eventType: string;
  appUserId: string;
  originalAppUserId?: string | null;
  aliasesJson?: string | null;
  environment: string;
  eventTimestamp: string;
  payloadHash: string;
}

export class RevenuecatEventAlreadyExistsError extends Error {
  existing: RevenuecatEventRow;
  constructor(existing: RevenuecatEventRow) {
    super("revenueCatEventIdが既に記録されています");
    this.name = "RevenuecatEventAlreadyExistsError";
    this.existing = existing;
  }
}

/**
 * `revenue_cat_event_id`のunique制約による冪等化（Mobile-G4、12章）。既に存在する場合は
 * 例外で返し、呼び出し側が`payloadHash`の一致/不一致を見て「単純な再送」か
 * 「同じevent.idで内容が異なる要調査ケース」かを判断する。
 */
export async function insertRevenuecatEvent(db: DbOrTx, params: InsertRevenuecatEventParams): Promise<RevenuecatEventRow> {
  try {
    const [row] = await db
      .insert(revenuecatEvents)
      .values({ ...params, processingStatus: "pending" })
      .returning();
    return row;
  } catch (e) {
    if (!isUniqueConstraintViolation(e)) throw e;
    const existing = await findRevenuecatEventById(db, params.revenueCatEventId);
    if (!existing) throw e;
    throw new RevenuecatEventAlreadyExistsError(existing);
  }
}

/** 任意のprocessingStatus・errorCodeでイベントを更新する汎用関数。 */
export async function markRevenuecatEventStatus(
  db: DbOrTx,
  id: number,
  status: string,
  errorCode?: string | null
): Promise<void> {
  await db
    .update(revenuecatEvents)
    .set({ processingStatus: status, errorCode: errorCode ?? null, processedAt: new Date().toISOString() })
    .where(eq(revenuecatEvents.id, id));
}

export async function markRevenuecatEventProcessed(db: DbOrTx, id: number, status: string): Promise<void> {
  await markRevenuecatEventStatus(db, id, status);
}

/**
 * TRANSFERイベントの再試行に必要な最小限のコンテキスト（transferred_from/to）を保存する
 * （Mobile-G4 Hardening、課金公開前Blocker対応）。rawPayload全体は保持しない方針を維持する。
 */
export async function updateRevenuecatEventTransferContext(
  db: DbOrTx,
  id: number,
  params: { transferredFromJson: string; transferredToJson: string }
): Promise<void> {
  await db
    .update(revenuecatEvents)
    .set({ transferredFromJson: params.transferredFromJson, transferredToJson: params.transferredToJson })
    .where(eq(revenuecatEvents.id, id));
}

export async function markRevenuecatEventError(db: DbOrTx, id: number, errorCode: string): Promise<void> {
  await markRevenuecatEventStatus(db, id, "error", errorCode);
}
