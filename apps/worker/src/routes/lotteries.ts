import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { getLotteryWithDetails, listLotteries } from "../repositories/lotteryRepository.ts";

/**
 * 公開 GET API（認証不要）。
 * GET /lotteries          — 抽選一覧（ページネーション / フィルタ）
 * GET /lotteries/:id      — 抽選詳細（lottery_sources + lottery_field_history 付き）
 */
export function registerLotteries(app: Hono<AppEnv>): void {
  app.get("/lotteries", async (c) => {
    const db = c.get("db");
    const cardType = c.req.query("cardType") ?? undefined;
    const verificationStatus = c.req.query("verificationStatus") ?? undefined;
    const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

    const result = await listLotteries(db, { cardType, verificationStatus, limit, offset });
    return c.json({ ok: true, lotteries: result.lotteries, total: result.total, limit, offset });
  });

  app.get("/lotteries/:id", async (c) => {
    const db = c.get("db");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ ok: false, error: "invalid_id" }, 400);
    }

    const detail = await getLotteryWithDetails(db, id);
    if (!detail) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    return c.json({ ok: true, ...detail });
  });
}
