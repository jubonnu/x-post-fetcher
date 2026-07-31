import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../db/client.ts";
import {
  lotteryProducts,
  productAliases,
  products,
  type ProductAliasRow,
  type ProductRow,
} from "../db/schema.ts";
import { isUniqueConstraintViolation } from "./userRepository.ts";

/**
 * `product_aliases.normalizer_version`はSQLiteのUNIQUE制約上、NULL同士は「異なる値」として
 * 扱われ一意性を保証しない（標準SQL/SQLiteの仕様）。このテーブルの一意性保証を常に有効に
 * 保つため、アプリケーション側では実際のバージョンが不明な場合でも生のnullを書き込まず、
 * このセンチネル値を使う（Mobile-G2B-1）。
 */
export const NORMALIZER_VERSION_UNKNOWN = "unknown";

export function coerceNormalizerVersion(version: string | null | undefined): string {
  return version && version.trim().length > 0 ? version : NORMALIZER_VERSION_UNKNOWN;
}

/** (normalizedAlias, normalizerVersion) の完全一致で商品IDを検索する（存在すれば1件のみ）。 */
export async function findProductIdByAliasAndVersion(
  db: DbOrTx,
  normalizedAlias: string,
  normalizerVersion: string
): Promise<number | null> {
  const rows = await db
    .select({ productId: productAliases.productId })
    .from(productAliases)
    .where(and(eq(productAliases.normalizedAlias, normalizedAlias), eq(productAliases.normalizerVersion, normalizerVersion)));
  return rows[0]?.productId ?? null;
}

/**
 * 同じ`normalizedAlias`文字列を持つ、バージョン違いの別名行すべてから、指している商品IDの
 * 集合（重複除去）を返す。1つに絞れない場合は呼び出し側で「要レビュー」扱いにする
 * （自動選択しない）。
 */
export async function findDistinctProductIdsByAlias(db: DbOrTx, normalizedAlias: string): Promise<number[]> {
  const rows = await db
    .select({ productId: productAliases.productId })
    .from(productAliases)
    .where(eq(productAliases.normalizedAlias, normalizedAlias));
  return [...new Set(rows.map((r) => r.productId))];
}

export async function findProductById(db: DbOrTx, productId: number): Promise<ProductRow | null> {
  const rows = await db.select().from(products).where(eq(products.id, productId));
  return rows[0] ?? null;
}

/** `publicProductId`（UUIDv4、外部公開用）から商品を検索する（Mobile-G2B-3）。 */
export async function findProductByPublicId(db: DbOrTx, publicProductId: string): Promise<ProductRow | null> {
  const rows = await db.select().from(products).where(eq(products.publicProductId, publicProductId));
  return rows[0] ?? null;
}

const MAX_MERGE_CHAIN_DEPTH = 10;

/**
 * `mergedIntoProductId`のチェーンを辿り、最終的な統合先の商品IDを返す。
 * 循環参照（データ不整合）に対する安全装置として最大深度を設ける。
 */
export async function resolveCanonicalProductId(db: DbOrTx, productId: number): Promise<number> {
  let currentId = productId;
  for (let depth = 0; depth < MAX_MERGE_CHAIN_DEPTH; depth++) {
    const product = await findProductById(db, currentId);
    if (!product || product.mergedIntoProductId === null) {
      return currentId;
    }
    currentId = product.mergedIntoProductId;
  }
  throw new Error(`mergedIntoProductIdのチェーンが深すぎます（循環参照の可能性）: 起点productId=${productId}`);
}

export interface CreateProductWithAliasParams {
  canonicalName: string;
  normalizedName: string;
  normalizerVersion: string;
  aliasSource: "initial_migration" | "re_normalization" | "manual_merge";
}

/**
 * 新規商品を作成し、同じトランザクション内で自己エイリアスも作成する（原子的、
 * Mobile-G2Aの`createUserWithAppleIdentityAtomic`と同じ「insertしてから別途updateしない」方針）。
 */
export async function createProductWithAlias(
  db: DbOrTx,
  params: CreateProductWithAliasParams
): Promise<{ product: ProductRow; alias: ProductAliasRow }> {
  return db.transaction(async (tx) => {
    const [product] = await tx
      .insert(products)
      .values({
        publicProductId: crypto.randomUUID(),
        canonicalName: params.canonicalName,
        normalizedName: params.normalizedName,
        normalizerVersion: params.normalizerVersion,
      })
      .returning();

    const [alias] = await tx
      .insert(productAliases)
      .values({
        productId: product.id,
        aliasName: params.canonicalName,
        normalizedAlias: params.normalizedName,
        normalizerVersion: params.normalizerVersion,
        source: params.aliasSource,
      })
      .returning();

    return { product, alias };
  });
}

/** 既存商品に対して、別バージョンの正規化名エイリアスを追加する（再正規化による継続性）。 */
export async function addAliasForExistingProduct(
  db: DbOrTx,
  params: { productId: number; aliasName: string; normalizedAlias: string; normalizerVersion: string; source: "initial_migration" | "re_normalization" | "manual_merge" }
): Promise<ProductAliasRow | null> {
  try {
    const [alias] = await db
      .insert(productAliases)
      .values({
        productId: params.productId,
        aliasName: params.aliasName,
        normalizedAlias: params.normalizedAlias,
        normalizerVersion: params.normalizerVersion,
        source: params.source,
      })
      .returning();
    return alias;
  } catch (e) {
    // 既に同じ(normalizedAlias, normalizerVersion)が存在する場合（並行実行等）は冪等に無視する。
    if (isUniqueConstraintViolation(e)) return null;
    throw e;
  }
}

/** 抽選と商品の対応を冪等に追加する（既に存在すれば何もしない）。 */
export async function linkLotteryToProduct(db: DbOrTx, lotteryId: number, productId: number): Promise<{ created: boolean }> {
  const existing = await db
    .select({ id: lotteryProducts.id })
    .from(lotteryProducts)
    .where(and(eq(lotteryProducts.lotteryId, lotteryId), eq(lotteryProducts.productId, productId)));
  if (existing.length > 0) return { created: false };

  try {
    await db.insert(lotteryProducts).values({ lotteryId, productId });
    return { created: true };
  } catch (e) {
    if (isUniqueConstraintViolation(e)) return { created: false };
    throw e;
  }
}

/** 指定した抽選IDの一覧について、既に紐付け済みのlotteryIdの集合を返す（バックフィルのスキップ判定用）。 */
export async function findLinkedLotteryIds(db: DbOrTx, lotteryIds: number[]): Promise<Set<number>> {
  if (lotteryIds.length === 0) return new Set();
  const rows = await db
    .select({ lotteryId: lotteryProducts.lotteryId })
    .from(lotteryProducts)
    .where(inArray(lotteryProducts.lotteryId, lotteryIds));
  return new Set(rows.map((r) => r.lotteryId));
}
