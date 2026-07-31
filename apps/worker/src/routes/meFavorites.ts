import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { requireAuth } from "../auth/middleware.ts";
import { ApiError, apiErrorJson } from "../auth/errors.ts";
import { lotteryExists } from "../repositories/lotteryRepository.ts";
import { addFavorite, listFavorites, removeFavorite } from "../repositories/favoriteRepository.ts";
import { deleteFavoriteSchema, putFavoriteSchema } from "../validation/syncSchemas.ts";
import { PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT } from "../validation/limits.ts";
import type { UserFavoriteRow } from "../db/schema.ts";
import { IdempotencyConflictError, runIdempotent } from "../services/idempotencyLedger.ts";

function toFavoriteResponse(row: UserFavoriteRow) {
  return { lotteryId: row.lotteryId, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function parseIdParam(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function parseJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/**
 * Mobile-G2B-3: /me/favorites系。すべて`requireAuth`必須、`userId`所有者チェック必須。
 * G2B-Hardening: PUT/DELETEは`runIdempotent`（scope="user_favorite"）で古い操作の
 * 遅延再送を防ぐ（詳細は`meLotteries.ts`と同じ設計）。
 */
export function registerMeFavorites(app: Hono<AppEnv>): void {
  app.get("/me/favorites", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? PAGINATION_DEFAULT_LIMIT), 1), PAGINATION_MAX_LIMIT);
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

    const { items, total } = await listFavorites(db, userId, { limit, offset });
    return c.json({ items: items.map(toFavoriteResponse), total, limit, offset });
  });

  app.put("/me/favorites/:lotteryId", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const lotteryId = parseIdParam(c.req.param("lotteryId"));
    if (lotteryId === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "lotteryIdが不正です"));

    const body = await parseJsonBody(c);
    const parsed = putFavoriteSchema.safeParse(body);
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));

    if (!(await lotteryExists(db, lotteryId))) {
      return apiErrorJson(c, new ApiError("NOT_FOUND", "指定された抽選が見つかりません"));
    }

    try {
      const response = await runIdempotent(
        db,
        { userId, scope: "user_favorite", clientRequestId: parsed.data.clientRequestId, requestPayload: { op: "put", lotteryId } },
        async (tx) => {
          const { row, outcome } = await addFavorite(tx, { userId, lotteryId });
          return { ...toFavoriteResponse(row), outcome };
        }
      );
      return c.json(response);
    } catch (e) {
      if (e instanceof IdempotencyConflictError) return apiErrorJson(c, new ApiError("IDEMPOTENCY_CONFLICT", e.message));
      throw e;
    }
  });

  app.delete("/me/favorites/:lotteryId", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const lotteryId = parseIdParam(c.req.param("lotteryId"));
    if (lotteryId === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "lotteryIdが不正です"));

    const body = await parseJsonBody(c);
    const parsed = deleteFavoriteSchema.safeParse(body ?? {});
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));

    try {
      const response = await runIdempotent(
        db,
        { userId, scope: "user_favorite", clientRequestId: parsed.data.clientRequestId, requestPayload: { op: "delete", lotteryId } },
        async (tx) => removeFavorite(tx, { userId, lotteryId })
      );
      if (!response.found) return apiErrorJson(c, new ApiError("NOT_FOUND", "お気に入りが見つかりません"));
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof IdempotencyConflictError) return apiErrorJson(c, new ApiError("IDEMPOTENCY_CONFLICT", e.message));
      throw e;
    }
  });
}
