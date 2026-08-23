import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import {
  getPublicLotteryWithDetails,
  listLotteries,
  withParsedApplicationUrls,
} from "../repositories/lotteryRepository.ts";
import { decodeLotteryListCursor, InvalidCursorError } from "../services/lotteryListCursor.ts";
import { isParsableDate } from "../validation/limits.ts";

/**
 * 公開 GET API（認証不要）。
 * GET /lotteries          — 抽選一覧（キーセットページネーション / フィルタ）
 * GET /lotteries/:id      — 抽選詳細（lottery_sources + lottery_field_history 付き）
 */
export function registerLotteries(app: Hono<AppEnv>): void {
  app.get("/lotteries", async (c) => {
    const db = c.get("db");
    const cardType = c.req.query("cardType") ?? undefined;
    const verificationStatus = c.req.query("verificationStatus") ?? undefined;
    const rawLimit = Number(c.req.query("limit") ?? 20);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1), 100);

    const cursorRaw = c.req.query("cursor") ?? undefined;
    const asOfQuery = c.req.query("asOf") ?? undefined;

    if (asOfQuery !== undefined && !isParsableDate(asOfQuery)) {
      return c.json({ ok: false, error: "invalid_asof" }, 400);
    }

    let cursor = null;
    if (cursorRaw !== undefined) {
      try {
        cursor = decodeLotteryListCursor(cursorRaw);
      } catch (e) {
        if (e instanceof InvalidCursorError) {
          return c.json({ ok: false, error: "invalid_cursor" }, 400);
        }
        throw e;
      }
      // cursorはasOfとセットで発行される。asOfクエリが無い、または発行時と異なるasOfが
      // 渡された場合は、異なる基準時刻のページを不整合に混ぜてしまうため拒否する。
      if (asOfQuery === undefined) {
        return c.json({ ok: false, error: "asof_required_with_cursor" }, 400);
      }
      if (asOfQuery !== cursor.asOf) {
        return c.json({ ok: false, error: "asof_mismatch" }, 400);
      }
    }

    const asOf = asOfQuery ?? new Date().toISOString();

    const result = await listLotteries(db, { cardType, verificationStatus, limit, cursor, asOf });
    return c.json({
      ok: true,
      lotteries: result.lotteries.map(withParsedApplicationUrls),
      total: result.total,
      limit,
      asOf,
      nextCursor: result.nextCursor,
    });
  });

  app.get("/lotteries/:id", async (c) => {
    const db = c.get("db");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ ok: false, error: "invalid_id" }, 400);
    }

    const detail = await getPublicLotteryWithDetails(db, id);
    if (!detail) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    return c.json({ ok: true, ...detail, lottery: withParsedApplicationUrls(detail.lottery) });
  });
}
