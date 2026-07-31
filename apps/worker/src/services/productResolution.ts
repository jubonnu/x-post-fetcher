import type { Db } from "../db/client.ts";
import {
  addAliasForExistingProduct,
  coerceNormalizerVersion,
  createProductWithAlias,
  findDistinctProductIdsByAlias,
  findProductIdByAliasAndVersion,
  resolveCanonicalProductId,
} from "../repositories/productRepository.ts";
import { isUniqueConstraintViolation } from "../repositories/userRepository.ts";

/**
 * 同一の`normalizedAlias`文字列が、バージョン違いの複数行を通じて2つ以上の異なる商品を
 * 指している（＝自動選択できない）場合に投げる。呼び出し側（バックフィル等）は
 * これを捕捉し、要レビュー扱いとして記録する（自動選択・自動統合は行わない）。
 */
export class AmbiguousProductAliasError extends Error {
  normalizedAlias: string;
  candidateProductIds: number[];
  constructor(normalizedAlias: string, candidateProductIds: number[]) {
    super(
      `normalizedAlias "${normalizedAlias}" が複数の商品(${candidateProductIds.join(", ")})を指しています。自動選択せず要レビューとします。`
    );
    this.name = "AmbiguousProductAliasError";
    this.normalizedAlias = normalizedAlias;
    this.candidateProductIds = candidateProductIds;
  }
}

export interface ResolveProductIdParams {
  /** 表示用の代表名（新規商品作成時の`canonicalName`・エイリアスの`aliasName`に使う）。 */
  representativeName: string;
  normalizedName: string;
  /** 未設定/空文字は内部でセンチネル値（'unknown'）へ丸められる。 */
  normalizerVersion?: string | null;
}

export interface ResolveProductIdResult {
  productId: number;
  created: boolean;
}

/**
 * 正規化済み商品名から商品IDを解決する（Mobile-G2B-1）。
 *
 * 手順:
 * 1. (normalizedName, normalizerVersion) の完全一致を検索 → あればそのままmergedInto
 *    チェーンを解決して返す
 * 2. 見つからなければ、同じnormalizedNameを持つ他バージョンの別名を横断検索する
 *    - 指している商品が1つだけ（バージョン違いのみ）→ 同一商品とみなし、
 *      現在のバージョンでの別名行を追加して再利用する（`source='re_normalization'`）
 *    - 指している商品が2つ以上 → `AmbiguousProductAliasError`を投げる（自動選択しない）
 * 3. どちらにも該当しなければ新規商品＋自己エイリアスを作成する
 *    （`source='initial_migration'`、呼び出し側が明示的に上書き可能）
 *
 * あいまい一致・大文字小文字変換等の追加正規化は一切行わない（完全一致のみ）。
 */
export async function resolveProductId(db: Db, params: ResolveProductIdParams): Promise<ResolveProductIdResult> {
  const normalizerVersion = coerceNormalizerVersion(params.normalizerVersion);

  const exactMatch = await findProductIdByAliasAndVersion(db, params.normalizedName, normalizerVersion);
  if (exactMatch !== null) {
    const canonicalId = await resolveCanonicalProductId(db, exactMatch);
    return { productId: canonicalId, created: false };
  }

  const candidateProductIds = await findDistinctProductIdsByAlias(db, params.normalizedName);
  if (candidateProductIds.length > 1) {
    throw new AmbiguousProductAliasError(params.normalizedName, candidateProductIds);
  }

  if (candidateProductIds.length === 1) {
    const [existingProductId] = candidateProductIds;
    await addAliasForExistingProduct(db, {
      productId: existingProductId,
      aliasName: params.representativeName,
      normalizedAlias: params.normalizedName,
      normalizerVersion,
      source: "re_normalization",
    });
    const canonicalId = await resolveCanonicalProductId(db, existingProductId);
    return { productId: canonicalId, created: false };
  }

  try {
    const { product } = await createProductWithAlias(db, {
      canonicalName: params.representativeName,
      normalizedName: params.normalizedName,
      normalizerVersion,
      aliasSource: "initial_migration",
    });
    return { productId: product.id, created: true };
  } catch (e) {
    if (!isUniqueConstraintViolation(e)) throw e;
    // 同時実行で別の呼び出しが先にこのエイリアスを作成済み（バックフィル/取り込みパイプラインの
    // 並行実行等）。500にはせず、既存の商品を再照会して再利用する
    // （Mobile-G2Aの同一Apple sub同時初回ログインと同じ考え方）。
    const winnerProductId = await findProductIdByAliasAndVersion(db, params.normalizedName, normalizerVersion);
    if (winnerProductId === null) throw e; // 理論上到達しないが、念のため元エラーを再送出する
    const canonicalId = await resolveCanonicalProductId(db, winnerProductId);
    return { productId: canonicalId, created: false };
  }
}
