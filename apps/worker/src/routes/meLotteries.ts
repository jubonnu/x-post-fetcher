import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { requireAuth } from "../auth/middleware.ts";
import { ApiError, apiErrorJson } from "../auth/errors.ts";
import { lotteryExists } from "../repositories/lotteryRepository.ts";
import {
  InvalidStatusTransitionError,
  VersionConflictError,
  findUserLottery,
  listUserLotteries,
  mergeSyncLotteryItem,
  softDeleteUserLottery,
  upsertUserLottery,
  type SyncConflictItem,
  type SyncMergedItem,
} from "../repositories/userLotteryRepository.ts";
import type { UserLotteryRow } from "../db/schema.ts";
import { serializeSnapshot, SnapshotTooLargeError } from "../validation/lotterySnapshot.ts";
import {
  deleteUserLotterySchema,
  patchUserLotteryStatusSchema,
  putUserLotterySchema,
  syncLotteriesRequestSchema,
} from "../validation/syncSchemas.ts";
import { PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT } from "../validation/limits.ts";
import type { LotteryStatus } from "../services/lotteryStatusTransitions.ts";
import { isLotteryStatus } from "../services/lotteryStatusTransitions.ts";
import { IdempotencyConflictError, runIdempotent } from "../services/idempotencyLedger.ts";

function toUserLotteryResponse(row: UserLotteryRow) {
  return {
    lotteryId: row.lotteryId,
    status: row.status,
    snapshotUpdatedAt: row.snapshotUpdatedAt,
    savedAt: row.savedAt,
    serverVersion: row.serverVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function parseJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function parseLotteryIdParam(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Mobile-G2B-2: /me/lotteries系（「自分の抽選」）。
 * すべて`requireAuth`必須。全クエリで`userId = 認証済みuserId`を必須化しIDORを構造的に防ぐ。
 *
 * G2B-Hardening: PUT/PATCH/DELETE/syncの各アイテムは`runIdempotent`（scope="user_lottery"）で
 * 台帳確認・実処理・台帳記録を単一トランザクションにまとめる。古い操作の遅延再送
 * （例: 追加→削除の後に古い追加が再送される）は、台帳が各clientRequestIdを恒久的に記録する
 * ため、行の現在状態に関わらず前回結果がそのまま返り、状態を変更しない。
 */
export function registerMeLotteries(app: Hono<AppEnv>): void {
  app.get("/me/lotteries", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;

    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? PAGINATION_DEFAULT_LIMIT), 1), PAGINATION_MAX_LIMIT);
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
    const statusParam = c.req.query("status");
    if (statusParam && !isLotteryStatus(statusParam)) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "statusの値が不正です"));
    }

    const { items, total } = await listUserLotteries(db, userId, {
      limit,
      offset,
      status: statusParam as LotteryStatus | undefined,
    });

    return c.json({ items: items.map(toUserLotteryResponse), total, limit, offset });
  });

  app.put("/me/lotteries/:lotteryId", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const lotteryId = parseLotteryIdParam(c.req.param("lotteryId"));
    if (lotteryId === null) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "lotteryIdが不正です"));
    }

    const body = await parseJsonBody(c);
    const parsed = putUserLotterySchema.safeParse(body);
    if (!parsed.success) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));
    }

    if (!(await lotteryExists(db, lotteryId))) {
      return apiErrorJson(c, new ApiError("NOT_FOUND", "指定された抽選が見つかりません"));
    }

    let snapshotJson: string | undefined;
    if (parsed.data.snapshot !== undefined) {
      try {
        snapshotJson = serializeSnapshot(parsed.data.snapshot);
      } catch (e) {
        if (e instanceof SnapshotTooLargeError) {
          return apiErrorJson(c, new ApiError("VALIDATION_ERROR", e.message));
        }
        throw e;
      }
    }

    try {
      const response = await runIdempotent(
        db,
        {
          userId,
          scope: "user_lottery",
          clientRequestId: parsed.data.clientRequestId,
          requestPayload: { op: "put", lotteryId, status: parsed.data.status ?? null, snapshotJson: snapshotJson ?? null, savedAt: parsed.data.savedAt ?? null, expectedServerVersion: parsed.data.expectedServerVersion ?? null },
        },
        async (tx) => {
          const { row, outcome } = await upsertUserLottery(tx, {
            userId,
            lotteryId,
            status: parsed.data.status,
            snapshotJson,
            savedAt: parsed.data.savedAt,
            expectedServerVersion: parsed.data.expectedServerVersion,
          });
          return { ...toUserLotteryResponse(row), outcome };
        }
      );
      return c.json(response);
    } catch (e) {
      if (e instanceof IdempotencyConflictError) {
        return apiErrorJson(c, new ApiError("IDEMPOTENCY_CONFLICT", e.message));
      }
      if (e instanceof VersionConflictError) {
        return c.json(
          {
            error: { code: "VERSION_CONFLICT", message: e.message, requestId: c.get("requestId") },
            current: toUserLotteryResponse(e.current),
          },
          409
        );
      }
      if (e instanceof InvalidStatusTransitionError) {
        return apiErrorJson(c, new ApiError("VALIDATION_ERROR", e.message));
      }
      throw e;
    }
  });

  app.patch("/me/lotteries/:lotteryId", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const lotteryId = parseLotteryIdParam(c.req.param("lotteryId"));
    if (lotteryId === null) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "lotteryIdが不正です"));
    }

    const body = await parseJsonBody(c);
    const parsed = patchUserLotteryStatusSchema.safeParse(body);
    if (!parsed.success) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));
    }

    const existing = await findUserLottery(db, userId, lotteryId);
    if (!existing) {
      return apiErrorJson(c, new ApiError("NOT_FOUND", "保存されていない抽選です"));
    }

    try {
      const response = await runIdempotent(
        db,
        {
          userId,
          scope: "user_lottery",
          clientRequestId: parsed.data.clientRequestId,
          requestPayload: { op: "patch", lotteryId, status: parsed.data.status, expectedServerVersion: parsed.data.expectedServerVersion },
        },
        async (tx) => {
          const { row, outcome } = await upsertUserLottery(tx, {
            userId,
            lotteryId,
            status: parsed.data.status,
            expectedServerVersion: parsed.data.expectedServerVersion,
          });
          return { ...toUserLotteryResponse(row), outcome };
        }
      );
      return c.json(response);
    } catch (e) {
      if (e instanceof IdempotencyConflictError) {
        return apiErrorJson(c, new ApiError("IDEMPOTENCY_CONFLICT", e.message));
      }
      if (e instanceof VersionConflictError) {
        return c.json(
          {
            error: { code: "VERSION_CONFLICT", message: e.message, requestId: c.get("requestId") },
            current: toUserLotteryResponse(e.current),
          },
          409
        );
      }
      if (e instanceof InvalidStatusTransitionError) {
        return apiErrorJson(c, new ApiError("VALIDATION_ERROR", e.message));
      }
      throw e;
    }
  });

  app.delete("/me/lotteries/:lotteryId", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const lotteryId = parseLotteryIdParam(c.req.param("lotteryId"));
    if (lotteryId === null) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "lotteryIdが不正です"));
    }

    const body = await parseJsonBody(c);
    const parsed = deleteUserLotterySchema.safeParse(body ?? {});
    if (!parsed.success) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));
    }

    try {
      const response = await runIdempotent(
        db,
        {
          userId,
          scope: "user_lottery",
          clientRequestId: parsed.data.clientRequestId,
          requestPayload: { op: "delete", lotteryId, expectedServerVersion: parsed.data.expectedServerVersion ?? null },
        },
        async (tx) => {
          const result = await softDeleteUserLottery(tx, {
            userId,
            lotteryId,
            expectedServerVersion: parsed.data.expectedServerVersion,
          });
          return { found: result.row !== null };
        }
      );
      if (!response.found) {
        return apiErrorJson(c, new ApiError("NOT_FOUND", "保存されていない抽選です"));
      }
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof IdempotencyConflictError) {
        return apiErrorJson(c, new ApiError("IDEMPOTENCY_CONFLICT", e.message));
      }
      if (e instanceof VersionConflictError) {
        return c.json(
          {
            error: { code: "VERSION_CONFLICT", message: e.message, requestId: c.get("requestId") },
            current: toUserLotteryResponse(e.current),
          },
          409
        );
      }
      throw e;
    }
  });

  app.post("/me/lotteries/sync", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;

    const body = await parseJsonBody(c);
    const parsed = syncLotteriesRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));
    }

    const merged: SyncMergedItem[] = [];
    const conflicts: SyncConflictItem[] = [];
    for (const item of parsed.data.items) {
      if (!(await lotteryExists(db, item.lotteryId))) continue; // 存在しない抽選IDは静かにスキップ（部分失敗の許容）
      let snapshotJson: string | undefined;
      if (item.snapshot !== undefined) {
        try {
          snapshotJson = serializeSnapshot(item.snapshot);
        } catch {
          continue; // 個別アイテムのsnapshot超過はそのアイテムのみスキップし、他は継続する
        }
      }

      try {
        const result = await runIdempotent(
          db,
          {
            userId,
            scope: "user_lottery",
            clientRequestId: item.clientRequestId,
            requestPayload: { op: "sync", lotteryId: item.lotteryId, status: item.status, savedAt: item.savedAt ?? null, snapshotJson: snapshotJson ?? null },
          },
          async (tx) => mergeSyncLotteryItem(tx, userId, { lotteryId: item.lotteryId, status: item.status, savedAt: item.savedAt, snapshotJson })
        );
        if (result.merged) merged.push(result.merged);
        if (result.conflict) conflicts.push(result.conflict);
      } catch (e) {
        if (e instanceof IdempotencyConflictError) {
          conflicts.push({ lotteryId: item.lotteryId, resolvedStatus: "unknown", reason: "idempotency_conflict" as const });
          continue;
        }
        throw e;
      }
    }

    return c.json({ merged, conflicts });
  });
}
