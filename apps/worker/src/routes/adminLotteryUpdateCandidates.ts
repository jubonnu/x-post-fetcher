import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireAdminAuth } from "../adminAuth/middleware.ts";
import { ApiError, apiErrorJson } from "../auth/errors.ts";
import { findAdminUserById } from "../repositories/adminUserRepository.ts";
import { sourcePosts } from "../db/schema.ts";
import {
  applyLotteryUpdateCandidate,
  getLotteryUpdateCandidateDiff,
  ignoreLotteryUpdateCandidate,
  listLotteryUpdateCandidates,
  registerLotteryUpdateCandidateAsNew,
} from "../repositories/lotteryUpdateCandidateRepository.ts";
import { withParsedApplicationUrls } from "../repositories/lotteryRepository.ts";
import { autoResolveLotteryUpdateCandidate } from "../services/autoResolveLotteryUpdateCandidate.ts";
import type { AppEnv } from "../env.ts";

const listQuerySchema = z.object({
  status: z.enum(["pending", "applied", "registered_as_new", "ignored"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const applyBodySchema = z.object({ fields: z.array(z.string().min(1)).min(1) });
const autoResolveBodySchema = z.object({ dryRun: z.boolean() });

function parseId(idParam: string | undefined): number | null {
  const id = Number(idParam);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function parseJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

type SourcePostSummary = {
  id: number;
  externalPostId: string;
  sourceUrl: string | null;
  bodyRaw: string | null;
  publishedAt: string | null;
} | null;

async function getSourcePostSummary(db: import("../db/client.ts").DbOrTx, id: number | null): Promise<SourcePostSummary> {
  if (id === null) return null;
  const rows = await db
    .select({
      id: sourcePosts.id,
      externalPostId: sourcePosts.externalPostId,
      sourceUrl: sourcePosts.sourceUrl,
      bodyRaw: sourcePosts.bodyRaw,
      publishedAt: sourcePosts.publishedAt,
    })
    .from(sourcePosts)
    .where(eq(sourcePosts.id, id));
  return rows[0] ?? null;
}

/**
 * 管理画面「更新候補」タブ用API（Phase 11）。
 * `lottery_update_candidates`は既存抽選への自動書き込みを一切行わない保留テーブルのため、
 * ここでのAPIはすべて「提示・管理者の明示的な選択に基づく反映」のみを行う。
 */
export function registerAdminLotteryUpdateCandidates(app: Hono<AppEnv>): void {
  app.get("/admin/lottery-update-candidates", requireAdminAuth, async (c) => {
    const parsed = listQuerySchema.safeParse({
      status: c.req.query("status") ?? undefined,
      limit: c.req.query("limit") ?? undefined,
      offset: c.req.query("offset") ?? undefined,
    });
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "クエリパラメータが不正です"));

    const db = c.get("db");
    const result = await listLotteryUpdateCandidates(db, parsed.data);
    return c.json({ items: result.candidates, total: result.total });
  });

  app.get("/admin/lottery-update-candidates/:id", requireAdminAuth, async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "idが不正です"));

    const db = c.get("db");
    const diff = await getLotteryUpdateCandidateDiff(db, id);
    if (!diff) return apiErrorJson(c, new ApiError("NOT_FOUND", "更新候補が見つかりません"));

    const [newSourcePost, existingSourcePost] = await Promise.all([
      getSourcePostSummary(db, diff.candidate.sourcePostId),
      getSourcePostSummary(db, diff.targetLottery?.sourcePostId ?? null),
    ]);

    return c.json({
      candidate: diff.candidate,
      targetLottery: diff.targetLottery ? withParsedApplicationUrls(diff.targetLottery) : null,
      extractedData: diff.extractedData,
      addableFields: diff.addableFields,
      overwritableFields: diff.overwritableFields,
      conflictingFields: diff.conflictingFields,
      matchingFields: diff.matchingFields,
      newSourcePost,
      existingSourcePost,
    });
  });

  app.post("/admin/lottery-update-candidates/:id/apply", requireAdminAuth, async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "idが不正です"));

    const body = await parseJsonBody(c);
    if (body === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストボディが不正です"));
    const parsed = applyBodySchema.safeParse(body);
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "fieldsが不正です"));

    const db = c.get("db");
    const admin = await findAdminUserById(db, c.get("adminUserId")!);
    const result = await applyLotteryUpdateCandidate(db, id, parsed.data.fields, admin!.email);

    if (result === "candidate_not_found") return apiErrorJson(c, new ApiError("NOT_FOUND", "更新候補が見つかりません"));
    if (result === "candidate_already_resolved") {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "この更新候補は既に処理済みです"));
    }
    if (result === "target_lottery_not_found") {
      return apiErrorJson(c, new ApiError("NOT_FOUND", "反映先の抽選が見つかりません"));
    }
    if (result === "no_fields_selected") {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "反映可能なフィールドが選択されていません"));
    }
    return c.json(result);
  });

  /**
   * 更新候補1件の自動判定（Phase後追い）。既存の`addable/overwritable/conflictingFields`分類と
   * 候補の元データがClaude in Chrome由来かどうかから、安全に自動処理してよいかを判定する。
   * まとめて処理せず1件ずつ呼ぶ設計にしているのは、Cloudflare Workersの1リクエストあたり
   * サブリクエスト数上限を避けるため（呼び出し側でIDごとにループする）。
   */
  app.post("/admin/lottery-update-candidates/:id/auto-resolve", requireAdminAuth, async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "idが不正です"));

    const body = await parseJsonBody(c);
    if (body === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストボディが不正です"));
    const parsed = autoResolveBodySchema.safeParse(body);
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "dryRunが不正です"));

    const db = c.get("db");
    const result = await autoResolveLotteryUpdateCandidate(db, id, parsed.data.dryRun);

    if (!result.ok) {
      if (result.error === "candidate_not_found") return apiErrorJson(c, new ApiError("NOT_FOUND", "更新候補が見つかりません"));
      if (result.error === "candidate_already_resolved") {
        return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "この更新候補は既に処理済みです"));
      }
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "自動反映に失敗しました"));
    }
    return c.json(result);
  });

  app.post("/admin/lottery-update-candidates/:id/register-as-new", requireAdminAuth, async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "idが不正です"));

    const db = c.get("db");
    const admin = await findAdminUserById(db, c.get("adminUserId")!);
    const result = await registerLotteryUpdateCandidateAsNew(db, id, admin!.email);

    if (result === "candidate_not_found") return apiErrorJson(c, new ApiError("NOT_FOUND", "更新候補が見つかりません"));
    if (result === "candidate_already_resolved") {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "この更新候補は既に処理済みです"));
    }
    return c.json(result);
  });

  app.post("/admin/lottery-update-candidates/:id/ignore", requireAdminAuth, async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "idが不正です"));

    const db = c.get("db");
    const admin = await findAdminUserById(db, c.get("adminUserId")!);
    const result = await ignoreLotteryUpdateCandidate(db, id, admin!.email);

    if (result === "candidate_not_found") return apiErrorJson(c, new ApiError("NOT_FOUND", "更新候補が見つかりません"));
    if (result === "candidate_already_resolved") {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "この更新候補は既に処理済みです"));
    }
    return c.json(result);
  });
}
