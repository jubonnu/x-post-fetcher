/**
 * Mobile-G2B-1: products/product_aliases/lottery_products のスキーマ制約確認。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { lotteryProducts, productAliases, products } from "../src/db/schema.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-product-schema-${Date.now()}.db`);
const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
});

afterAll(() => {
  rmSync(DB_FILE);
});

async function insertProduct(overrides: Partial<typeof products.$inferInsert> = {}) {
  const [product] = await db
    .insert(products)
    .values({
      publicProductId: crypto.randomUUID(),
      canonicalName: "テスト商品",
      normalizedName: "テスト商品",
      normalizerVersion: "v1",
      ...overrides,
    })
    .returning();
  return product;
}

describe("products", () => {
  it("publicProductIdはunique", async () => {
    const dup = crypto.randomUUID();
    await insertProduct({ publicProductId: dup, normalizedName: "商品A" });
    await expect(insertProduct({ publicProductId: dup, normalizedName: "商品B" })).rejects.toThrow();
  });

  it("lifecycleStatusは'active'/'merged'/'archived'以外を拒否する", async () => {
    await expect(insertProduct({ normalizedName: "商品C", lifecycleStatus: "invalid_status" })).rejects.toThrow();
  });

  it("lifecycleStatusが許可値なら成功する", async () => {
    const p1 = await insertProduct({ normalizedName: "商品D1", lifecycleStatus: "active" });
    const p2 = await insertProduct({ normalizedName: "商品D2", lifecycleStatus: "archived" });
    expect(p1.lifecycleStatus).toBe("active");
    expect(p2.lifecycleStatus).toBe("archived");
  });

  it("mergedIntoProductIdの自己参照は拒否される", async () => {
    const product = await insertProduct({ normalizedName: "商品E" });
    await expect(
      db.update(products).set({ mergedIntoProductId: product.id }).where(eq(products.id, product.id))
    ).rejects.toThrow();
  });

  it("mergedIntoProductIdが他の商品を指すのは許可される", async () => {
    const target = await insertProduct({ normalizedName: "商品F-target" });
    const source = await insertProduct({ normalizedName: "商品F-source" });
    await db
      .update(products)
      .set({ mergedIntoProductId: target.id, lifecycleStatus: "merged" })
      .where(eq(products.id, source.id));

    const [updated] = await db.select().from(products).where(eq(products.id, source.id));
    expect(updated.mergedIntoProductId).toBe(target.id);
    expect(updated.lifecycleStatus).toBe("merged");
  });
});

describe("product_aliases", () => {
  it("(normalizedAlias, normalizerVersion)の組はunique", async () => {
    const product = await insertProduct({ normalizedName: "商品G" });
    await db.insert(productAliases).values({
      productId: product.id,
      aliasName: "商品G",
      normalizedAlias: "商品G-alias",
      normalizerVersion: "v1",
      source: "initial_migration",
    });

    await expect(
      db.insert(productAliases).values({
        productId: product.id,
        aliasName: "商品G(別名)",
        normalizedAlias: "商品G-alias",
        normalizerVersion: "v1",
        source: "manual_merge",
      })
    ).rejects.toThrow();
  });

  it("同じnormalizedAliasでもnormalizerVersionが異なれば別行として許可される", async () => {
    const product = await insertProduct({ normalizedName: "商品H" });
    await db.insert(productAliases).values({
      productId: product.id,
      aliasName: "商品H",
      normalizedAlias: "商品H-alias",
      normalizerVersion: "v1",
      source: "initial_migration",
    });

    await expect(
      db.insert(productAliases).values({
        productId: product.id,
        aliasName: "商品H",
        normalizedAlias: "商品H-alias",
        normalizerVersion: "v2",
        source: "re_normalization",
      })
    ).resolves.toBeDefined();
  });
});

describe("lottery_products", () => {
  it("(lotteryId, productId)の組はunique", async () => {
    const product = await insertProduct({ normalizedName: "商品I" });
    await db.insert(lotteryProducts).values({ lotteryId: 9001, productId: product.id });

    await expect(db.insert(lotteryProducts).values({ lotteryId: 9001, productId: product.id })).rejects.toThrow();
  });

  it("同一lotteryIdに複数productIdを関連付けられる（将来の1抽選複数商品に対応）", async () => {
    const productA = await insertProduct({ normalizedName: "商品J-A" });
    const productB = await insertProduct({ normalizedName: "商品J-B" });
    await db.insert(lotteryProducts).values({ lotteryId: 9002, productId: productA.id });

    await expect(
      db.insert(lotteryProducts).values({ lotteryId: 9002, productId: productB.id })
    ).resolves.toBeDefined();
  });
});
