import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { lotteries } from "../db/schema.ts";
import { getLotteryWithDetails, listLotteriesByOffset } from "../repositories/lotteryRepository.ts";
import { enqueueJob } from "../repositories/processingJobRepository.ts";
import { sourcePosts } from "../db/schema.ts";

/**
 * 内部管理 API（Bearer 認証必須）。
 * GET  /internal/review-items              — needs_review / conflicting の一覧
 * GET  /internal/review-items/:id          — 詳細（sources + fieldHistory 付き）
 * POST /internal/review-items/:id/approve  — 承認（verificationStatus=approved）
 * POST /internal/review-items/:id/reject   — 却下（verificationStatus=rejected）
 * POST /internal/source-posts/:id/reanalyze — 再解析ジョブをエンキュー
 */
export function registerReview(app: Hono<AppEnv>): void {
  // Bearer 認証ミドルウェア（/internal/* に適用）
  app.use("/internal/*", async (c, next) => {
    const token = c.get("env").INGEST_TOKEN;
    const authHeader = c.req.header("Authorization") ?? "";
    if (!token || authHeader !== `Bearer ${token}`) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    await next();
  });

  // --- review-items -------------------------------------------------------

  app.get("/internal/review-items", async (c) => {
    const db = c.get("db");
    const statusFilter = c.req.query("status") ?? "needs_review";
    const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

    const result = await listLotteriesByOffset(db, { verificationStatus: statusFilter, limit, offset });
    return c.json({ ok: true, items: result.lotteries, total: result.total, limit, offset });
  });

  app.get("/internal/review-items/:id", async (c) => {
    const db = c.get("db");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: "invalid_id" }, 400);

    const detail = await getLotteryWithDetails(db, id);
    if (!detail) return c.json({ ok: false, error: "not_found" }, 404);
    return c.json({ ok: true, ...detail });
  });

  app.post("/internal/review-items/:id/approve", async (c) => {
    const db = c.get("db");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: "invalid_id" }, 400);

    const rows = await db.select({ id: lotteries.id }).from(lotteries).where(eq(lotteries.id, id));
    if (rows.length === 0) return c.json({ ok: false, error: "not_found" }, 404);

    let body: { approvedBy?: string } = {};
    try {
      body = (await c.req.json().catch(() => ({}))) as typeof body;
    } catch {
      // 不正なJSON/空bodyは許容する（このエンドポイントの全フィールドが任意項目のため、パース失敗時は空objectのまま続行する）
    }

    const now = new Date().toISOString();
    await db
      .update(lotteries)
      .set({
        verificationStatus: "approved",
        approvedBy: body.approvedBy ?? null,
        approvedAt: now,
        updatedAt: now,
      })
      .where(eq(lotteries.id, id));

    return c.json({ ok: true, id, verificationStatus: "approved", approvedAt: now });
  });

  app.post("/internal/review-items/:id/reject", async (c) => {
    const db = c.get("db");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: "invalid_id" }, 400);

    const rows = await db.select({ id: lotteries.id }).from(lotteries).where(eq(lotteries.id, id));
    if (rows.length === 0) return c.json({ ok: false, error: "not_found" }, 404);

    let body: { reason?: string; rejectedBy?: string } = {};
    try {
      body = (await c.req.json().catch(() => ({}))) as typeof body;
    } catch {
      // 不正なJSON/空bodyは許容する（このエンドポイントの全フィールドが任意項目のため、パース失敗時は空objectのまま続行する）
    }

    const now = new Date().toISOString();
    await db
      .update(lotteries)
      .set({
        verificationStatus: "rejected",
        rejectedReason: body.reason ?? null,
        rejectedAt: now,
        updatedAt: now,
      })
      .where(eq(lotteries.id, id));

    return c.json({ ok: true, id, verificationStatus: "rejected", rejectedAt: now });
  });

  // --- source-posts -------------------------------------------------------

  app.post("/internal/source-posts/:id/reanalyze", async (c) => {
    const db = c.get("db");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: "invalid_id" }, 400);

    const rows = await db.select({ id: sourcePosts.id }).from(sourcePosts).where(eq(sourcePosts.id, id));
    if (rows.length === 0) return c.json({ ok: false, error: "not_found" }, 404);

    const { enqueued } = await enqueueJob(db, "analyze_post", { sourcePostId: id });
    return c.json({ ok: true, sourcePostId: id, enqueued });
  });
}
