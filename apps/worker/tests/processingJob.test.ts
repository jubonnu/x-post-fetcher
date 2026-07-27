import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.node.ts";
import { processingJobs } from "../src/db/schema.ts";
import {
  enqueueJob,
  dequeueOne,
  markJobComplete,
  markJobFailed,
} from "../src/repositories/processingJobRepository.ts";

let dbFile: string;
let db: ReturnType<typeof createDb>;

beforeEach(async () => {
  dbFile = resolve(process.cwd(), `.tmp-pjob-${Date.now()}.db`);
  process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
  db = createDb({ TURSO_DATABASE_URL: `file:${dbFile}` });
  await migrate(db, { migrationsFolder: "./migrations" });
});

afterEach(() => {
  if (existsSync(dbFile)) rmSync(dbFile);
});

describe("processingJobRepository", () => {
  it("enqueue でジョブが作成される", async () => {
    const r = await enqueueJob(db, "resolve_urls", { lotteryId: 1 });
    expect(r.enqueued).toBe(true);
    const jobs = await db.select().from(processingJobs).where(eq(processingJobs.lotteryId, 1));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("pending");
    expect(jobs[0].jobType).toBe("resolve_urls");
  });

  it("同一 lotteryId の pending/running が存在する場合は重複エンキューしない", async () => {
    await enqueueJob(db, "resolve_urls", { lotteryId: 1 });
    const r2 = await enqueueJob(db, "resolve_urls", { lotteryId: 1 });
    expect(r2.enqueued).toBe(false);
    const jobs = await db.select().from(processingJobs).where(eq(processingJobs.lotteryId, 1));
    expect(jobs).toHaveLength(1);
  });

  it("別 lotteryId なら別ジョブとしてエンキューできる", async () => {
    await enqueueJob(db, "resolve_urls", { lotteryId: 1 });
    const r2 = await enqueueJob(db, "resolve_urls", { lotteryId: 2 });
    expect(r2.enqueued).toBe(true);
  });

  it("dequeueOne で pending ジョブが running になる", async () => {
    await enqueueJob(db, "resolve_urls", { lotteryId: 10 });
    const job = await dequeueOne(db, "resolve_urls");
    expect(job).not.toBeNull();
    expect(job!.status).toBe("running");
    expect(job!.lotteryId).toBe(10);
    expect(job!.lockedAt).not.toBeNull();
  });

  it("ジョブがなければ dequeueOne は null", async () => {
    const job = await dequeueOne(db, "resolve_urls");
    expect(job).toBeNull();
  });

  it("dequeue 後の同一ジョブは running なので再取得されない", async () => {
    await enqueueJob(db, "resolve_urls", { lotteryId: 20 });
    await dequeueOne(db, "resolve_urls"); // 取得済み → running
    const job2 = await dequeueOne(db, "resolve_urls");
    expect(job2).toBeNull(); // pending がないので null
  });

  it("markJobComplete で done になり completedAt がセットされる", async () => {
    await enqueueJob(db, "resolve_urls", { lotteryId: 30 });
    const job = await dequeueOne(db, "resolve_urls");
    await markJobComplete(db, job!.id);
    const [updated] = await db.select().from(processingJobs).where(eq(processingJobs.id, job!.id));
    expect(updated.status).toBe("done");
    expect(updated.completedAt).not.toBeNull();
  });

  it("markJobFailed (attempts 0/3) → pending でリトライ待ち", async () => {
    await enqueueJob(db, "resolve_urls", { lotteryId: 40 });
    const job = await dequeueOne(db, "resolve_urls");
    await markJobFailed(db, job!.id, "timeout", 0, 3);
    const [updated] = await db.select().from(processingJobs).where(eq(processingJobs.id, job!.id));
    expect(updated.status).toBe("pending");
    expect(updated.attempts).toBe(1);
    expect(updated.nextRetryAt).not.toBeNull();
    expect(updated.lastError).toBe("timeout");
  });

  it("markJobFailed (attempts 2/3) → failed で確定", async () => {
    await enqueueJob(db, "resolve_urls", { lotteryId: 50 });
    const job = await dequeueOne(db, "resolve_urls");
    await markJobFailed(db, job!.id, "network error", 2, 3);
    const [updated] = await db.select().from(processingJobs).where(eq(processingJobs.id, job!.id));
    expect(updated.status).toBe("failed");
    expect(updated.attempts).toBe(3);
  });
});
