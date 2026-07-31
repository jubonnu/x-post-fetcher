/**
 * Mobile-G2B-1: resolveProductId（正規化名からの商品解決）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { productAliases, products } from "../src/db/schema.ts";
import { AmbiguousProductAliasError, resolveProductId } from "../src/services/productResolution.ts";
import { resolveCanonicalProductId } from "../src/repositories/productRepository.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-product-resolution-${Date.now()}.db`);
const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
});

afterAll(() => {
  rmSync(DB_FILE);
});

describe("resolveProductId", () => {
  it("新規の正規化名は新しい商品を作成する", async () => {
    const result = await resolveProductId(db, { representativeName: "MEGAドリームex", normalizedName: "MEGAドリームex", normalizerVersion: "v1" });
    expect(result.created).toBe(true);

    const [product] = await db.select().from(products).where(eq(products.id, result.productId));
    expect(product.normalizedName).toBe("MEGAドリームex");
    expect(product.canonicalName).toBe("MEGAドリームex");
  });

  it("同じ(normalizedName, normalizerVersion)を再度解決すると同じ商品を再利用する（新規作成しない）", async () => {
    const first = await resolveProductId(db, { representativeName: "テラスタルフェス", normalizedName: "テラスタルフェス", normalizerVersion: "v1" });
    const second = await resolveProductId(db, { representativeName: "テラスタルフェス", normalizedName: "テラスタルフェス", normalizerVersion: "v1" });

    expect(second.created).toBe(false);
    expect(second.productId).toBe(first.productId);
  });

  it("normalizerVersionが異なる同じ文字列は、既存商品への別バージョンエイリアスとして再利用される", async () => {
    const v1 = await resolveProductId(db, { representativeName: "ポケカ151BOX", normalizedName: "ポケカ151BOX", normalizerVersion: "v1" });
    const v2 = await resolveProductId(db, { representativeName: "ポケカ151BOX", normalizedName: "ポケカ151BOX", normalizerVersion: "v2" });

    expect(v2.created).toBe(false);
    expect(v2.productId).toBe(v1.productId);

    const aliasRows = await db.select().from(productAliases).where(eq(productAliases.normalizedAlias, "ポケカ151BOX"));
    expect(aliasRows).toHaveLength(2);
    expect(new Set(aliasRows.map((a) => a.normalizerVersion))).toEqual(new Set(["v1", "v2"]));
  });

  it("normalizerVersion未指定はセンチネル値'unknown'に丸められる", async () => {
    const result = await resolveProductId(db, { representativeName: "バージョン不明商品", normalizedName: "バージョン不明商品", normalizerVersion: null });
    const [alias] = await db.select().from(productAliases).where(eq(productAliases.productId, result.productId));
    expect(alias.normalizerVersion).toBe("unknown");
  });

  it("同じnormalizedNameが複数の異なる商品を指す場合はAmbiguousProductAliasErrorになる（自動選択しない）", async () => {
    // 意図的に手動で「異常な状態」を作る: 同じ文字列がバージョン違いで別々の商品を指す
    const productA = await resolveProductId(db, { representativeName: "曖昧商品", normalizedName: "曖昧商品", normalizerVersion: "v1" });
    // v2用に別の商品を手動作成し、同じ文字列のエイリアスを付ける（本来resolveProductIdは
    // 既存商品を再利用するため到達しないが、データ不整合の異常系として直接検証する）
    const [productB] = await db
      .insert(products)
      .values({ publicProductId: crypto.randomUUID(), canonicalName: "曖昧商品(別)", normalizedName: "曖昧商品" })
      .returning();
    await db.insert(productAliases).values({
      productId: productB.id,
      aliasName: "曖昧商品(別)",
      normalizedAlias: "曖昧商品",
      normalizerVersion: "v2",
      source: "manual_merge",
    });

    await expect(
      resolveProductId(db, { representativeName: "曖昧商品", normalizedName: "曖昧商品", normalizerVersion: "v3" })
    ).rejects.toThrow(AmbiguousProductAliasError);

    try {
      await resolveProductId(db, { representativeName: "曖昧商品", normalizedName: "曖昧商品", normalizerVersion: "v3" });
    } catch (e) {
      expect(e).toBeInstanceOf(AmbiguousProductAliasError);
      const err = e as AmbiguousProductAliasError;
      expect(err.candidateProductIds.sort()).toEqual([productA.productId, productB.id].sort());
    }
  });

  it("mergedIntoProductIdのチェーンを辿って統合先の商品IDを返す", async () => {
    const original = await resolveProductId(db, { representativeName: "統合前商品", normalizedName: "統合前商品", normalizerVersion: "v1" });
    const [target] = await db
      .insert(products)
      .values({ publicProductId: crypto.randomUUID(), canonicalName: "統合後商品", normalizedName: "統合後商品" })
      .returning();
    await db
      .update(products)
      .set({ mergedIntoProductId: target.id, lifecycleStatus: "merged" })
      .where(eq(products.id, original.productId));

    const canonical = await resolveCanonicalProductId(db, original.productId);
    expect(canonical).toBe(target.id);

    // 統合済みの旧商品名で再度解決しても、統合先のIDが返る
    const resolvedAgain = await resolveProductId(db, { representativeName: "統合前商品", normalizedName: "統合前商品", normalizerVersion: "v1" });
    expect(resolvedAgain.productId).toBe(target.id);
  });

  it("同時に同じ新規正規化名を解決しようとした場合、商品が重複作成されない", async () => {
    // ローカルのlibSQLファイルクライアントは、同時に複数の書き込みトランザクションが
    // 発生するとSQLITE_BUSYを返すことがある（Mobile-G2A-Hardeningで確認済みの既知の制約。
    // 本番のTurso（クライアント/サーバー型）はこの制約を受けない可能性が高い）。
    // ここでは「重複作成されない」ことを確定的に検証し、両方が成功するかは問わない
    // （片方がSQLITE_BUSYで失敗しても、それは生の500ではなく識別可能なエラーである）。
    const normalizedName = "同時解決商品";
    const attempt = (v: number) =>
      resolveProductId(db, { representativeName: normalizedName, normalizedName, normalizerVersion: "v1" }).catch(
        (e) => ({ error: e as Error, attempt: v })
      );

    const [resultA, resultB] = await Promise.all([attempt(1), attempt(2)]);
    const succeeded = [resultA, resultB].filter((r): r is { productId: number; created: boolean } => !("error" in r));

    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    if (succeeded.length === 2) {
      expect(succeeded[0].productId).toBe(succeeded[1].productId);
    }

    const productRows = await db.select().from(products).where(eq(products.normalizedName, normalizedName));
    expect(productRows).toHaveLength(1); // 何度試みても重複作成されない
  });
});
