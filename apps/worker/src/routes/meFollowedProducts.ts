import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { requireAuth } from "../auth/middleware.ts";
import { ApiError, apiErrorJson } from "../auth/errors.ts";
import { findProductByPublicId, findProductById, resolveCanonicalProductId } from "../repositories/productRepository.ts";
import { addFollow, listFollowedProducts, removeFollow, type FollowedProductWithProduct } from "../repositories/followedProductRepository.ts";
import { deleteFollowedProductSchema, putFollowedProductSchema } from "../validation/syncSchemas.ts";
import { PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT } from "../validation/limits.ts";
import type { Db } from "../db/client.ts";
import { IdempotencyConflictError, runIdempotent } from "../services/idempotencyLedger.ts";

function toFollowedProductResponse(item: FollowedProductWithProduct) {
  return {
    publicProductId: item.product.publicProductId,
    canonicalName: item.product.canonicalName,
    lifecycleStatus: item.product.lifecycleStatus,
    createdAt: item.follow.createdAt,
    updatedAt: item.follow.updatedAt,
  };
}

async function parseJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/**
 * `publicProductId`から実際にフォロー対象とすべき内部productIdを解決する
 * （統合チェーンを辿り、最終的な統合先を返す。Mobile-G2B-3）。
 * 存在しない場合はnull。
 */
async function resolvePublicProductId(db: Db, publicProductId: string): Promise<{ productId: number } | null> {
  const product = await findProductByPublicId(db, publicProductId);
  if (!product) return null;
  const canonicalId = await resolveCanonicalProductId(db, product.id);
  return { productId: canonicalId };
}

const PUBLIC_PRODUCT_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mobile-G2B-3: /me/followed-products系。
 * G2B-Hardening: PUT/DELETEは`runIdempotent`（scope="followed_product"）で古い操作の
 * 遅延再送を防ぐ。resourceKeyは解決後の内部productIdではなく`publicProductId`
 * （クライアントが実際に指定した値）をハッシュへ含める（統合により内部productIdが
 * 将来変わりうるため、クライアント視点の対象を安定して識別する）。
 */
export function registerMeFollowedProducts(app: Hono<AppEnv>): void {
  app.get("/me/followed-products", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? PAGINATION_DEFAULT_LIMIT), 1), PAGINATION_MAX_LIMIT);
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

    const { items, total } = await listFollowedProducts(db, userId, { limit, offset });
    return c.json({ items: items.map(toFollowedProductResponse), total, limit, offset });
  });

  app.put("/me/followed-products/:publicProductId", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const publicProductId = c.req.param("publicProductId");
    if (!publicProductId || !PUBLIC_PRODUCT_ID_REGEX.test(publicProductId)) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "publicProductIdはUUID形式である必要があります"));
    }

    const body = await parseJsonBody(c);
    const parsed = putFollowedProductSchema.safeParse(body);
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));

    const resolved = await resolvePublicProductId(db, publicProductId);
    if (!resolved) return apiErrorJson(c, new ApiError("NOT_FOUND", "指定された商品が見つかりません"));

    const canonicalProduct = await findProductById(db, resolved.productId);
    if (!canonicalProduct) return apiErrorJson(c, new ApiError("NOT_FOUND", "指定された商品が見つかりません"));
    if (canonicalProduct.lifecycleStatus === "archived") {
      return apiErrorJson(c, new ApiError("CONFLICT", "この商品はアーカイブされているためフォローできません"));
    }

    try {
      const response = await runIdempotent(
        db,
        { userId, scope: "followed_product", clientRequestId: parsed.data.clientRequestId, requestPayload: { op: "put", publicProductId } },
        async (tx) => {
          const { outcome } = await addFollow(tx, { userId, productId: resolved.productId });
          return {
            publicProductId: canonicalProduct.publicProductId,
            canonicalName: canonicalProduct.canonicalName,
            lifecycleStatus: canonicalProduct.lifecycleStatus,
            outcome,
          };
        }
      );
      return c.json(response);
    } catch (e) {
      if (e instanceof IdempotencyConflictError) return apiErrorJson(c, new ApiError("IDEMPOTENCY_CONFLICT", e.message));
      throw e;
    }
  });

  app.delete("/me/followed-products/:publicProductId", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const publicProductId = c.req.param("publicProductId");
    if (!publicProductId || !PUBLIC_PRODUCT_ID_REGEX.test(publicProductId)) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "publicProductIdはUUID形式である必要があります"));
    }

    const body = await parseJsonBody(c);
    const parsed = deleteFollowedProductSchema.safeParse(body ?? {});
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));

    const resolved = await resolvePublicProductId(db, publicProductId);
    if (!resolved) return apiErrorJson(c, new ApiError("NOT_FOUND", "指定された商品が見つかりません"));

    try {
      const response = await runIdempotent(
        db,
        { userId, scope: "followed_product", clientRequestId: parsed.data.clientRequestId, requestPayload: { op: "delete", publicProductId } },
        async (tx) => removeFollow(tx, { userId, productId: resolved.productId })
      );
      if (!response.found) return apiErrorJson(c, new ApiError("NOT_FOUND", "フォローが見つかりません"));
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof IdempotencyConflictError) return apiErrorJson(c, new ApiError("IDEMPOTENCY_CONFLICT", e.message));
      throw e;
    }
  });
}
