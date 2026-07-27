import { and, asc, eq, inArray, or, isNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { processingJobs, type JobType, type ProcessingJobRow } from "../db/schema.ts";

export type { ProcessingJobRow };

/**
 * ジョブをエンキューする。同一 jobType × lotteryId（または sourcePostId）の
 * pending/running ジョブが既に存在する場合はスキップ（二重登録防止）。
 */
export async function enqueueJob(
  db: Db,
  jobType: JobType,
  opts: { lotteryId?: number; sourcePostId?: number; payload?: unknown }
): Promise<{ enqueued: boolean }> {
  const { lotteryId, sourcePostId, payload } = opts;

  // pending/running の重複チェック
  const conditions = [
    eq(processingJobs.jobType, jobType),
    inArray(processingJobs.status, ["pending", "running"]),
    ...(lotteryId !== undefined ? [eq(processingJobs.lotteryId, lotteryId)] : []),
    ...(sourcePostId !== undefined && lotteryId === undefined
      ? [eq(processingJobs.sourcePostId, sourcePostId)]
      : []),
  ];
  const existing = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(and(...conditions));

  if (existing.length > 0) return { enqueued: false };

  await db.insert(processingJobs).values({
    jobType,
    status: "pending",
    lotteryId: lotteryId ?? null,
    sourcePostId: sourcePostId ?? null,
    payload: payload !== undefined ? JSON.stringify(payload) : null,
    attempts: 0,
    maxAttempts: 3,
  });

  return { enqueued: true };
}

/**
 * 指定 jobType の oldest-pending ジョブを1件ロック取得してデキューする。
 * nextRetryAt が未来のジョブはスキップ（リトライ待ち）。
 * ジョブがなければ null。
 */
export async function dequeueOne(db: Db, jobType: JobType): Promise<ProcessingJobRow | null> {
  const now = new Date().toISOString();
  const pending = await db
    .select()
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.jobType, jobType),
        eq(processingJobs.status, "pending"),
        or(isNull(processingJobs.nextRetryAt), lte(processingJobs.nextRetryAt, now))
      )
    )
    .orderBy(asc(processingJobs.createdAt))
    .limit(1);

  if (pending.length === 0) return null;
  const job = pending[0];

  const lockedBy = `worker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db
    .update(processingJobs)
    .set({ status: "running", lockedAt: now, lockedBy, updatedAt: now })
    .where(and(eq(processingJobs.id, job.id), eq(processingJobs.status, "pending")));

  const locked = await db
    .select()
    .from(processingJobs)
    .where(and(eq(processingJobs.id, job.id), eq(processingJobs.lockedBy, lockedBy)));

  return locked.length > 0 ? (locked[0] as ProcessingJobRow) : null;
}

/** ジョブを完了（done）にする。 */
export async function markJobComplete(db: Db, id: number): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(processingJobs)
    .set({ status: "done", completedAt: now, updatedAt: now })
    .where(eq(processingJobs.id, id));
}

/**
 * ジョブを失敗扱いにする。
 * attempts < maxAttempts なら pending に戻して指数バックオフでリトライ。
 * 上限に達したら failed に固定。
 */
export async function markJobFailed(
  db: Db,
  id: number,
  error: string,
  currentAttempts: number,
  maxAttempts: number
): Promise<void> {
  const now = new Date().toISOString();
  const newAttempts = currentAttempts + 1;

  if (newAttempts < maxAttempts) {
    // 指数バックオフ: 1分 / 5分 / 15分
    const backoffMs = [60_000, 300_000, 900_000][Math.min(newAttempts - 1, 2)];
    const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
    await db
      .update(processingJobs)
      .set({
        status: "pending",
        attempts: newAttempts,
        lastError: error,
        nextRetryAt,
        lockedAt: null,
        lockedBy: null,
        updatedAt: now,
      })
      .where(eq(processingJobs.id, id));
  } else {
    await db
      .update(processingJobs)
      .set({ status: "failed", attempts: newAttempts, lastError: error, updatedAt: now })
      .where(eq(processingJobs.id, id));
  }
}
