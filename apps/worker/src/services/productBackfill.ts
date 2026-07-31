import { isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { lotteries } from "../db/schema.ts";
import { linkLotteryToProduct } from "../repositories/productRepository.ts";
import { AmbiguousProductAliasError, resolveProductId } from "./productResolution.ts";

export interface ProductBackfillNeedsReview {
  normalizedName: string;
  candidateProductIds: number[];
}

export interface ProductBackfillResult {
  distinctNormalizedNamesProcessed: number;
  productsCreated: number;
  productsReused: number;
  lotteriesLinked: number;
  lotteriesAlreadyLinked: number;
  lotteriesSkippedNullOrEmpty: number;
  needsReview: ProductBackfillNeedsReview[];
}

/**
 * 既存`lotteries`から`products`/`product_aliases`/`lottery_products`をバックフィルする
 * （Mobile-G2B-1）。`lotteries`テーブルへは一切書き込まない。
 *
 * 冪等性・安全な再実行: 各ステップ（商品の解決/作成・エイリアス追加・lottery_products紐付け）は
 * それぞれ独立して冪等（`resolveProductId`は既存の完全一致を再利用、`linkLotteryToProduct`は
 * 既存の組み合わせを検出してスキップ）。そのため本関数全体を1つの巨大なトランザクションで
 * 囲むことはせず、処理が途中で中断しても、単純に再実行すれば未処理分だけが処理される
 * （既に作成済みの商品・紐付けは自然にスキップされ重複しない）。
 *
 * 前後空白のみ・空文字・nullの`normalizedProductName`はすべてスキップする
 * （`normalizeProductName`は本来これらをnullに正規化するため通常発生しないが、念のため
 * 3つとも明示的にガードする）。
 */
export async function backfillProductsFromLotteries(db: Db): Promise<ProductBackfillResult> {
  const result: ProductBackfillResult = {
    distinctNormalizedNamesProcessed: 0,
    productsCreated: 0,
    productsReused: 0,
    lotteriesLinked: 0,
    lotteriesAlreadyLinked: 0,
    lotteriesSkippedNullOrEmpty: 0,
    needsReview: [],
  };

  const allLotteries = await db
    .select({
      id: lotteries.id,
      normalizedProductName: lotteries.normalizedProductName,
      productNameRaw: lotteries.productNameRaw,
      normalizerVersion: lotteries.normalizerVersion,
      createdAt: lotteries.createdAt,
    })
    .from(lotteries)
    .where(isNotNull(lotteries.normalizedProductName));

  const groups = new Map<string, typeof allLotteries>();
  for (const row of allLotteries) {
    const key = row.normalizedProductName?.trim() ?? "";
    if (key.length === 0) {
      result.lotteriesSkippedNullOrEmpty += 1;
      continue;
    }
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  for (const [normalizedName, rows] of groups) {
    result.distinctNormalizedNamesProcessed += 1;

    // 代表行: productNameRawが非nullかつcreatedAtが最新のもの
    const representative =
      rows
        .filter((r) => r.productNameRaw && r.productNameRaw.trim().length > 0)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? rows[0];

    let productId: number;
    try {
      const resolved = await resolveProductId(db, {
        representativeName: representative.productNameRaw?.trim() || normalizedName,
        normalizedName,
        normalizerVersion: representative.normalizerVersion,
      });
      productId = resolved.productId;
      if (resolved.created) result.productsCreated += 1;
      else result.productsReused += 1;
    } catch (e) {
      if (e instanceof AmbiguousProductAliasError) {
        result.needsReview.push({ normalizedName, candidateProductIds: e.candidateProductIds });
        continue; // この正規化名に属する抽選は今回リンクしない（要レビュー）
      }
      throw e;
    }

    for (const row of rows) {
      const { created } = await linkLotteryToProduct(db, row.id, productId);
      if (created) result.lotteriesLinked += 1;
      else result.lotteriesAlreadyLinked += 1;
    }
  }

  return result;
}
