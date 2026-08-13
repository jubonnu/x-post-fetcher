import type { Hono } from "hono";
import { z } from "zod";
import { requireAdminAuth } from "../adminAuth/middleware.ts";
import { ApiError, apiErrorJson } from "../auth/errors.ts";
import { findAdminUserById } from "../repositories/adminUserRepository.ts";
import {
  approveLotteryByAdmin,
  createLotteryByAdmin,
  getLotteryWithDetails,
  listLotteriesForAdmin,
  mergeLotteryIntoTarget,
  rejectLotteryByAdmin,
  updateLotteryByAdmin,
  type AdminLotteryCreateInput,
  type AdminLotteryUpdateInput,
} from "../repositories/lotteryRepository.ts";
import type { AppEnv } from "../env.ts";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const listQuerySchema = z.object({
  verificationStatus: z.string().optional(),
  // カンマ区切り（例: "approved,rejected"）。「要確認」タブ用——これ以外の値（NULL含む）を対象にする。
  excludeVerificationStatuses: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined)),
  // 「重複として統合」の統合先を探すための商品名・店舗名の部分一致検索（Phase 8）。
  search: z.string().max(200).optional(),
  // 元投稿がXに投稿された日時（sourcePosts.publishedAt）での絞り込み。ISO8601（Phase 9）。
  sourcePostPublishedAtFrom: z.string().datetime().optional(),
  sourcePostPublishedAtTo: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const mergeIntoBodySchema = z.object({ targetId: z.number().int().positive() });

// 空文字は「クリア」の意図で送られてくる想定のためnullへ正規化する（フォームのテキスト欄クリア操作を想定）。
const nullableText = z
  .string()
  .max(2000)
  .nullable()
  .transform((v) => (v === "" ? null : v));

const createLotterySchema = z.object({
  productNameRaw: z.string().trim().min(1).max(2000),
  storeNameRaw: z.string().trim().min(1).max(2000),
  applicationEndAt: z.string().datetime().nullable().optional(),
  resultAnnouncementAt: z.string().datetime().nullable().optional(),
  purchaseDeadlineAt: z.string().datetime().nullable().optional(),
  applicationMethod: nullableText.optional(),
  applicationUrl: nullableText.optional(),
});

const updateLotterySchema = z.object({
  productNameRaw: nullableText.optional(),
  storeNameRaw: nullableText.optional(),
  applicationEndAt: z.string().datetime().nullable().optional(),
  resultAnnouncementAt: z.string().datetime().nullable().optional(),
  purchaseDeadlineAt: z.string().datetime().nullable().optional(),
  applicationMethod: nullableText.optional(),
  applicationUrl: nullableText.optional(),
});

const rejectBodySchema = z.object({ reason: z.string().max(2000).nullable().optional() });

function parseId(idParam: string | undefined): number | null {
  const id = Number(idParam);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** `${origin}/images/${key}`形式のURLからR2のオブジェクトキーを取り出す。形式が違えばnull。 */
function extractImageKey(imageUrl: string): string | null {
  try {
    const path = new URL(imageUrl).pathname;
    const match = /^\/images\/(.+)$/.exec(path);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

async function parseJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/**
 * 管理画面（Phase 7）用の抽選CRUD API。`/admin/*`全体に`requireAdminAuthConfigured`が
 * app.ts側で適用済みの前提。全エンドポイントに`requireAdminAuth`を個別付与する
 * （`/admin/auth/*`のsignup/loginのみ未認証で叩けるようにするため、ここではまとめてuseしない）。
 */
export function registerAdminLotteries(app: Hono<AppEnv>): void {
  app.get("/admin/lotteries", requireAdminAuth, async (c) => {
    const parsed = listQuerySchema.safeParse({
      verificationStatus: c.req.query("verificationStatus") ?? undefined,
      excludeVerificationStatuses: c.req.query("excludeVerificationStatuses") ?? undefined,
      search: c.req.query("search") ?? undefined,
      sourcePostPublishedAtFrom: c.req.query("sourcePostPublishedAtFrom") ?? undefined,
      sourcePostPublishedAtTo: c.req.query("sourcePostPublishedAtTo") ?? undefined,
      limit: c.req.query("limit") ?? undefined,
      offset: c.req.query("offset") ?? undefined,
    });
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "クエリパラメータが不正です"));

    const db = c.get("db");
    const result = await listLotteriesForAdmin(db, parsed.data);
    return c.json({ items: result.lotteries, total: result.total });
  });

  app.post("/admin/lotteries", requireAdminAuth, async (c) => {
    const body = await parseJsonBody(c);
    if (body === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストボディが不正です"));

    const parsed = createLotterySchema.safeParse(body);
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));

    const db = c.get("db");
    const id = await createLotteryByAdmin(db, parsed.data as AdminLotteryCreateInput);
    const created = await getLotteryWithDetails(db, id);
    return c.json(created, 201);
  });

  app.get("/admin/lotteries/:id", requireAdminAuth, async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "idが不正です"));

    const db = c.get("db");
    const detail = await getLotteryWithDetails(db, id);
    if (!detail) return apiErrorJson(c, new ApiError("NOT_FOUND", "抽選が見つかりません"));
    return c.json(detail);
  });

  app.post("/admin/lotteries/:id/approve", requireAdminAuth, async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "idが不正です"));

    const db = c.get("db");
    const detail = await getLotteryWithDetails(db, id);
    if (!detail) return apiErrorJson(c, new ApiError("NOT_FOUND", "抽選が見つかりません"));

    const admin = await findAdminUserById(db, c.get("adminUserId")!);
    await approveLotteryByAdmin(db, id, admin!.email);
    return c.json({ ok: true });
  });

  app.post("/admin/lotteries/:id/reject", requireAdminAuth, async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "idが不正です"));

    const db = c.get("db");
    const detail = await getLotteryWithDetails(db, id);
    if (!detail) return apiErrorJson(c, new ApiError("NOT_FOUND", "抽選が見つかりません"));

    const body = (await parseJsonBody(c)) ?? {};
    const parsed = rejectBodySchema.safeParse(body);
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));

    await rejectLotteryByAdmin(db, id, parsed.data.reason ?? null);
    return c.json({ ok: true });
  });

  app.patch("/admin/lotteries/:id", requireAdminAuth, async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "idが不正です"));

    const db = c.get("db");
    const detail = await getLotteryWithDetails(db, id);
    if (!detail) return apiErrorJson(c, new ApiError("NOT_FOUND", "抽選が見つかりません"));

    const body = await parseJsonBody(c);
    if (body === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストボディが不正です"));

    const parsed = updateLotterySchema.safeParse(body);
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));

    await updateLotteryByAdmin(db, id, parsed.data as AdminLotteryUpdateInput);
    const updated = await getLotteryWithDetails(db, id);
    return c.json(updated);
  });

  app.post("/admin/lotteries/:id/image", requireAdminAuth, async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "idが不正です"));

    const db = c.get("db");
    const detail = await getLotteryWithDetails(db, id);
    if (!detail) return apiErrorJson(c, new ApiError("NOT_FOUND", "抽選が見つかりません"));

    const contentType = c.req.header("Content-Type") ?? "";
    const extension = EXTENSION_BY_CONTENT_TYPE[contentType];
    if (!extension) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "対応していない画像形式です（png/jpeg/webpのみ）"));
    }

    const bucket = c.get("env").LOTTERY_IMAGES;
    if (!bucket) return apiErrorJson(c, new ApiError("CONFIG_ERROR", "画像保存先が設定されていません"));

    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "画像データが空です"));
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "画像サイズが上限（5MB）を超えています"));
    }

    const key = `${id}-${Date.now()}.${extension}`;
    await bucket.put(key, bytes, { httpMetadata: { contentType } });

    // モバイルアプリはこのURLをそのまま`<Image>`へ渡すだけなので、相対パスではなく
    // このWorker自身のoriginを含む絶対URLで保存する（このリクエストが実際に届いたoriginを使う
    // ことで、staging/production・カスタムドメインの違いを気にせず正しいURLになる）。
    const origin = new URL(c.req.url).origin;
    const imageUrl = `${origin}/images/${key}`;
    await updateLotteryByAdmin(db, id, { imageUrl });
    return c.json({ imageUrl });
  });

  app.delete("/admin/lotteries/:id/image", requireAdminAuth, async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "idが不正です"));

    const db = c.get("db");
    const detail = await getLotteryWithDetails(db, id);
    if (!detail) return apiErrorJson(c, new ApiError("NOT_FOUND", "抽選が見つかりません"));

    if (!detail.lottery.imageUrl) {
      // 元々画像が無い場合も、呼び出し側から見れば「画像が無い状態」という結果は
      // 変わらないため冪等に成功とする（削除ボタンの二重クリック等を気にしなくてよい）。
      return c.json({ ok: true });
    }

    const bucket = c.get("env").LOTTERY_IMAGES;
    if (!bucket) return apiErrorJson(c, new ApiError("CONFIG_ERROR", "画像保存先が設定されていません"));

    const key = extractImageKey(detail.lottery.imageUrl);
    if (key) {
      // R2からの削除が失敗しても、DB側のimageUrlクリアは進める（孤立オブジェクトが
      // 残るより、管理画面上「画像なし」に見えているのにアプリには表示され続ける方が
      // 実害が大きいため）。R2側のエラーはログに残すのみでレスポンスには影響させない。
      await bucket.delete(key).catch((e: unknown) => {
        console.error(JSON.stringify({ event: "admin_image_delete_failed", lotteryId: id, key, message: e instanceof Error ? e.message : String(e) }));
      });
    }

    await updateLotteryByAdmin(db, id, { imageUrl: null });
    return c.json({ ok: true });
  });

  app.post("/admin/lotteries/:id/merge-into", requireAdminAuth, async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "idが不正です"));

    const body = await parseJsonBody(c);
    if (body === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストボディが不正です"));
    const parsed = mergeIntoBodySchema.safeParse(body);
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "targetIdが不正です"));

    const db = c.get("db");
    const result = await mergeLotteryIntoTarget(db, id, parsed.data.targetId);

    if (result === "duplicate_not_found") return apiErrorJson(c, new ApiError("NOT_FOUND", "抽選が見つかりません"));
    if (result === "target_not_found") return apiErrorJson(c, new ApiError("NOT_FOUND", "統合先の抽選が見つかりません"));
    if (result === "same_lottery") return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "自分自身には統合できません"));
    if (result === "target_already_merged") {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "統合先が既に別の抽選へ統合されています"));
    }

    return c.json(result);
  });
}
