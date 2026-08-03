import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { requireAuth } from "../auth/middleware.ts";
import { requirePremium } from "../auth/premiumMiddleware.ts";
import { getStatisticsMonthly, getStatisticsStores, getStatisticsSummary } from "../repositories/statisticsRepository.ts";
import {
  STATISTICS_MONTHLY_DEFAULT_MONTHS,
  STATISTICS_MONTHLY_MAX_MONTHS,
  STATISTICS_STORES_DEFAULT_LIMIT,
  STATISTICS_STORES_MAX_LIMIT,
} from "../validation/limits.ts";

/**
 * Mobile-G6: `/me/statistics/*`。「保存した抽選」の応募・当選実績を集計して返す、premium必須のAPI。
 * `docs/mobile-g1-...`5.7節が想定する5エンドポイントのうち、既存の統計画面（旧モック）が
 * 必要とするsummary/monthly/storesの3種のみを今回実装する（categories/activityは未実装、
 * 将来の拡張余地として残す）。
 */
export function registerMeStatistics(app: Hono<AppEnv>): void {
  app.get("/me/statistics/summary", requireAuth, requirePremium, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const summary = await getStatisticsSummary(db, userId);
    return c.json(summary);
  });

  app.get("/me/statistics/monthly", requireAuth, requirePremium, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const months = Math.min(Math.max(Number(c.req.query("months") ?? STATISTICS_MONTHLY_DEFAULT_MONTHS), 1), STATISTICS_MONTHLY_MAX_MONTHS);
    const items = await getStatisticsMonthly(db, userId, months);
    return c.json({ items });
  });

  app.get("/me/statistics/stores", requireAuth, requirePremium, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? STATISTICS_STORES_DEFAULT_LIMIT), 1), STATISTICS_STORES_MAX_LIMIT);
    const items = await getStatisticsStores(db, userId, limit);
    return c.json({ items });
  });
}
