/**
 * Mobile-G2B-1: 既存lotteriesからのproductsバックフィル。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { lotteries, lotteryProducts, productAliases, products } from "../src/db/schema.ts";
import { backfillProductsFromLotteries } from "../src/services/productBackfill.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-product-backfill-${Date.now()}.db`);
const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
});

afterAll(() => {
  rmSync(DB_FILE);
});

async function insertLottery(overrides: Partial<typeof lotteries.$inferInsert> = {}) {
  const [row] = await db
    .insert(lotteries)
    .values({
      productNameRaw: "テスト商品",
      normalizedProductName: "テスト商品",
      verificationStatus: "extracted",
      ...overrides,
    })
    .returning();
  return row;
}

describe("backfillProductsFromLotteries", () => {
  it("正常な1商品: 抽選1件から商品1件・紐付け1件が作成される", async () => {
    const lottery = await insertLottery({ productNameRaw: "MEGAドリームex", normalizedProductName: "MEGAドリームex", normalizerVersion: "v1" });

    const result = await backfillProductsFromLotteries(db);

    expect(result.productsCreated).toBeGreaterThanOrEqual(1);
    const links = await db.select().from(lotteryProducts).where(eq(lotteryProducts.lotteryId, lottery.id));
    expect(links).toHaveLength(1);
  });

  it("同じnormalizedProductNameの複数抽選は同じ商品に紐付く", async () => {
    const l1 = await insertLottery({ productNameRaw: "テラスタルフェス", normalizedProductName: "テラスタルフェス", normalizerVersion: "v1" });
    const l2 = await insertLottery({ productNameRaw: "テラスタルフェス", normalizedProductName: "テラスタルフェス", normalizerVersion: "v1" });

    await backfillProductsFromLotteries(db);

    const link1 = await db.select().from(lotteryProducts).where(eq(lotteryProducts.lotteryId, l1.id));
    const link2 = await db.select().from(lotteryProducts).where(eq(lotteryProducts.lotteryId, l2.id));
    expect(link1[0].productId).toBe(link2[0].productId);
  });

  it("normalizedProductNameがnullの抽選はスキップされる", async () => {
    const before = await backfillProductsFromLotteries(db);
    const nullLottery = await insertLottery({ productNameRaw: null, normalizedProductName: null });

    const after = await backfillProductsFromLotteries(db);
    const link = await db.select().from(lotteryProducts).where(eq(lotteryProducts.lotteryId, nullLottery.id));
    expect(link).toHaveLength(0);
    expect(after.distinctNormalizedNamesProcessed).toBe(before.distinctNormalizedNamesProcessed);
  });

  it("正規化後が空文字・空白のみのケースもスキップされる（正規化済みlotteries行を直接投入して検証）", async () => {
    // normalizeProductName自体は空文字をnullへ丸めるため、実運用では発生しないが、
    // データ不整合に対する防御として明示的に検証する。
    const emptyLottery = await insertLottery({ productNameRaw: "　", normalizedProductName: "" });
    const whitespaceLottery = await insertLottery({ productNameRaw: "　", normalizedProductName: "   " });

    const result = await backfillProductsFromLotteries(db);

    const emptyLink = await db.select().from(lotteryProducts).where(eq(lotteryProducts.lotteryId, emptyLottery.id));
    const whitespaceLink = await db.select().from(lotteryProducts).where(eq(lotteryProducts.lotteryId, whitespaceLottery.id));
    expect(emptyLink).toHaveLength(0);
    expect(whitespaceLink).toHaveLength(0);
    expect(result.lotteriesSkippedNullOrEmpty).toBeGreaterThanOrEqual(2);
  });

  it("同じバックフィルを2回実行しても重複しない（冪等性）", async () => {
    const lottery = await insertLottery({ productNameRaw: "冪等性確認商品", normalizedProductName: "冪等性確認商品", normalizerVersion: "v1" });

    await backfillProductsFromLotteries(db);
    const productsAfterFirst = await db.select().from(products).where(eq(products.normalizedName, "冪等性確認商品"));

    const secondResult = await backfillProductsFromLotteries(db);
    const productsAfterSecond = await db.select().from(products).where(eq(products.normalizedName, "冪等性確認商品"));
    const linksAfterSecond = await db.select().from(lotteryProducts).where(eq(lotteryProducts.lotteryId, lottery.id));

    expect(productsAfterFirst).toHaveLength(1);
    expect(productsAfterSecond).toHaveLength(1); // 2回目で増えない
    expect(linksAfterSecond).toHaveLength(1); // 紐付けも増えない
    expect(secondResult.lotteriesAlreadyLinked).toBeGreaterThanOrEqual(1);
  });

  it("productsが既に存在する場合は再利用する", async () => {
    const [existingProduct] = await db
      .insert(products)
      .values({ publicProductId: crypto.randomUUID(), canonicalName: "既存商品", normalizedName: "既存商品扱い", normalizerVersion: "v1" })
      .returning();
    await db.insert(productAliases).values({
      productId: existingProduct.id,
      aliasName: "既存商品",
      normalizedAlias: "既存商品扱い",
      normalizerVersion: "v1",
      source: "manual_merge",
    });

    const lottery = await insertLottery({ productNameRaw: "既存商品(新規投稿)", normalizedProductName: "既存商品扱い", normalizerVersion: "v1" });
    await backfillProductsFromLotteries(db);

    const link = await db.select().from(lotteryProducts).where(eq(lotteryProducts.lotteryId, lottery.id));
    expect(link[0].productId).toBe(existingProduct.id);

    const productRows = await db.select().from(products).where(eq(products.normalizedName, "既存商品扱い"));
    expect(productRows).toHaveLength(1); // 新規作成されていない
  });

  it("lottery_productsが既に存在する場合は再作成しない", async () => {
    const lottery = await insertLottery({ productNameRaw: "既存紐付け商品", normalizedProductName: "既存紐付け商品", normalizerVersion: "v1" });
    await backfillProductsFromLotteries(db);

    const [linkBefore] = await db.select().from(lotteryProducts).where(eq(lotteryProducts.lotteryId, lottery.id));
    await backfillProductsFromLotteries(db);
    const linksAfter = await db.select().from(lotteryProducts).where(eq(lotteryProducts.lotteryId, lottery.id));

    expect(linksAfter).toHaveLength(1);
    expect(linksAfter[0].id).toBe(linkBefore.id); // 同じ行のまま（再作成されていない）
  });

  it("normalizerVersionが異なる同名商品は同一商品として再利用され、別バージョンのエイリアスが追加される", async () => {
    const lotteryV1 = await insertLottery({ productNameRaw: "バージョン差分商品", normalizedProductName: "バージョン差分商品", normalizerVersion: "v1" });
    await backfillProductsFromLotteries(db);

    const lotteryV2 = await insertLottery({ productNameRaw: "バージョン差分商品", normalizedProductName: "バージョン差分商品", normalizerVersion: "v2" });
    await backfillProductsFromLotteries(db);

    const linkV1 = await db.select().from(lotteryProducts).where(eq(lotteryProducts.lotteryId, lotteryV1.id));
    const linkV2 = await db.select().from(lotteryProducts).where(eq(lotteryProducts.lotteryId, lotteryV2.id));
    expect(linkV1[0].productId).toBe(linkV2[0].productId);
  });

  it("同一normalizedAliasに複数候補がある異常系は要レビュー扱いになり、該当抽選は紐付けられない", async () => {
    const [productA] = await db
      .insert(products)
      .values({ publicProductId: crypto.randomUUID(), canonicalName: "競合商品A", normalizedName: "競合商品" })
      .returning();
    await db.insert(productAliases).values({
      productId: productA.id,
      aliasName: "競合商品A",
      normalizedAlias: "競合商品",
      normalizerVersion: "v1",
      source: "manual_merge",
    });
    const [productB] = await db
      .insert(products)
      .values({ publicProductId: crypto.randomUUID(), canonicalName: "競合商品B", normalizedName: "競合商品" })
      .returning();
    await db.insert(productAliases).values({
      productId: productB.id,
      aliasName: "競合商品B",
      normalizedAlias: "競合商品",
      normalizerVersion: "v2",
      source: "manual_merge",
    });

    const conflictLottery = await insertLottery({ productNameRaw: "競合商品(新規)", normalizedProductName: "競合商品", normalizerVersion: "v3" });
    const result = await backfillProductsFromLotteries(db);

    expect(result.needsReview.some((r) => r.normalizedName === "競合商品")).toBe(true);
    const link = await db.select().from(lotteryProducts).where(eq(lotteryProducts.lotteryId, conflictLottery.id));
    expect(link).toHaveLength(0); // 要レビューのため紐付けされない
  });

  it("一部の商品解決が失敗しても、他の正規化名の処理は継続され、再実行すれば安全に続きから処理できる", async () => {
    const okLottery = await insertLottery({ productNameRaw: "安全な商品", normalizedProductName: "安全な商品", normalizerVersion: "v1" });
    const result = await backfillProductsFromLotteries(db);

    const link = await db.select().from(lotteryProducts).where(eq(lotteryProducts.lotteryId, okLottery.id));
    expect(link).toHaveLength(1); // 他の異常系（前のテストの要レビュー商品）とは独立して正常処理される
    expect(result.distinctNormalizedNamesProcessed).toBeGreaterThan(0);
  });

  it("既存lotteriesのデータは一切変更されない", async () => {
    const lottery = await insertLottery({
      productNameRaw: "不変確認商品",
      normalizedProductName: "不変確認商品",
      normalizerVersion: "v1",
      verificationStatus: "extracted",
    });
    const before = await db.select().from(lotteries).where(eq(lotteries.id, lottery.id));

    await backfillProductsFromLotteries(db);

    const after = await db.select().from(lotteries).where(eq(lotteries.id, lottery.id));
    expect(after[0]).toEqual(before[0]);
  });
});
