import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { requireAuth } from "../auth/middleware.ts";
import { ApiError, apiErrorJson } from "../auth/errors.ts";
import { findUserLottery } from "../repositories/userLotteryRepository.ts";
import {
  ChecklistVersionConflictError,
  countActiveChecklistSteps,
  findChecklistStep,
  listChecklistSteps,
  softDeleteChecklistStep,
  upsertChecklistStepRow,
} from "../repositories/checklistRepository.ts";
import { isDefaultChecklistStepId } from "../services/checklistDefaults.ts";
import { IdempotencyConflictError, runIdempotent } from "../services/idempotencyLedger.ts";
import { putChecklistSchema, clientRequestIdSchema } from "../validation/syncSchemas.ts";
import { CHECKLIST_MAX_STEPS_PER_LOTTERY } from "../validation/limits.ts";
import type { ChecklistProgressRow } from "../db/schema.ts";
import type { Db } from "../db/client.ts";

function toStepResponse(row: ChecklistProgressRow) {
  return {
    stepId: row.stepId,
    label: row.label,
    done: row.done,
    completedAt: row.completedAt,
    completedNote: row.completedNote,
    sortOrder: row.sortOrder,
    serverVersion: row.serverVersion,
    clientActionAt: row.clientActionAt,
    isDefault: isDefaultChecklistStepId(row.stepId),
  };
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

type StepItemResult =
  | ({ stepId: string; ok: true } & ReturnType<typeof toStepResponse>)
  | { stepId: string; ok: false; error: { code: string; message: string } };

async function processStepItem(
  db: Db,
  userId: number,
  lotteryId: number,
  item: {
    stepId: string;
    label: string;
    done: boolean;
    completedNote?: string | null;
    sortOrder?: number;
    clientActionAt?: string;
    expectedServerVersion: number;
    clientRequestId: string;
  },
  currentStepCount: { count: number }
): Promise<StepItemResult> {
  const requestPayload = {
    op: "put",
    lotteryId,
    stepId: item.stepId,
    label: item.label,
    done: item.done,
    completedNote: item.completedNote ?? null,
    sortOrder: item.sortOrder ?? null,
    clientActionAt: item.clientActionAt ?? null,
    expectedServerVersion: item.expectedServerVersion,
  };

  try {
    return await runIdempotent(
      db,
      { userId, scope: "checklist_step", clientRequestId: item.clientRequestId, requestPayload },
      async (tx) => {
        const isNewStep = !(await findChecklistStep(tx, userId, lotteryId, item.stepId));
        if (isNewStep && currentStepCount.count >= CHECKLIST_MAX_STEPS_PER_LOTTERY) {
          return { stepId: item.stepId, ok: false, error: { code: "VALIDATION_ERROR", message: "チェックリストのステップ数上限を超えています" } } satisfies StepItemResult;
        }
        const { row } = await upsertChecklistStepRow(tx, {
          userId,
          lotteryId,
          stepId: item.stepId,
          label: item.label,
          done: item.done,
          completedNote: item.completedNote,
          sortOrder: item.sortOrder,
          clientActionAt: item.clientActionAt,
          expectedServerVersion: item.expectedServerVersion,
        });
        if (isNewStep) currentStepCount.count += 1;
        return { ok: true, ...toStepResponse(row) } satisfies StepItemResult;
      }
    );
  } catch (e) {
    if (e instanceof IdempotencyConflictError) {
      return { stepId: item.stepId, ok: false, error: { code: "IDEMPOTENCY_CONFLICT", message: e.message } };
    }
    if (e instanceof ChecklistVersionConflictError) {
      return { stepId: item.stepId, ok: false, error: { code: "VERSION_CONFLICT", message: e.message } };
    }
    throw e;
  }
}

/** Mobile-G2B-4: /me/checklists系。 */
export function registerMeChecklists(app: Hono<AppEnv>): void {
  app.get("/me/checklists/:lotteryId", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const lotteryId = parseIdParam(c.req.param("lotteryId"));
    if (lotteryId === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "lotteryIdが不正です"));

    const steps = await listChecklistSteps(db, userId, lotteryId);
    return c.json({ items: steps.map(toStepResponse) });
  });

  app.put("/me/checklists/:lotteryId", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const lotteryId = parseIdParam(c.req.param("lotteryId"));
    if (lotteryId === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "lotteryIdが不正です"));

    const body = await parseJsonBody(c);
    const parsed = putChecklistSchema.safeParse(body);
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));

    if (!(await findUserLottery(db, userId, lotteryId))) {
      return apiErrorJson(c, new ApiError("NOT_FOUND", "保存されていない抽選です"));
    }

    const currentStepCount = { count: await countActiveChecklistSteps(db, userId, lotteryId) };
    const results: StepItemResult[] = [];
    for (const item of parsed.data.steps) {
      results.push(await processStepItem(db, userId, lotteryId, item, currentStepCount));
    }

    return c.json({ results });
  });

  app.delete("/me/checklists/:lotteryId/:stepId", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const lotteryId = parseIdParam(c.req.param("lotteryId"));
    const stepId = c.req.param("stepId");
    if (lotteryId === null || !stepId) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "パラメータが不正です"));

    const body = await parseJsonBody(c);
    const parsed = clientRequestIdSchema.safeParse((body as { clientRequestId?: unknown })?.clientRequestId);
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "clientRequestIdが必要です"));

    const result = await softDeleteChecklistStep(db, { userId, lotteryId, stepId, isDefaultStep: isDefaultChecklistStepId(stepId) });
    if (result === "not_found") return apiErrorJson(c, new ApiError("NOT_FOUND", "ステップが見つかりません"));
    if (result === "default_step_forbidden") {
      return apiErrorJson(c, new ApiError("CONFLICT", "デフォルトステップは削除できません"));
    }
    return c.json({ ok: true });
  });
}
