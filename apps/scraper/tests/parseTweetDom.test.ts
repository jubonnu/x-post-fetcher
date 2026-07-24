import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTweetArticle } from "../src/scraping/x/parseTweetDom.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(resolve(here, "fixtures", name), "utf-8");

describe("parseTweetArticle (React DOM fixtures)", () => {
  it("single-product: 全フィールドを抽出できる", () => {
    const post = parseTweetArticle(fixture("single-product.html"));
    expect(post).not.toBeNull();
    expect(post!.tweetId).toBe("1988548187880059026");
    expect(post!.publishedAt).toBe("2026-07-23T12:52:18.000Z");
    expect(post!.sourceUrl).toBe("https://x.com/zabi_poc/status/1988548187880059026");
    expect(post!.authorUsername).toBe("zabi_poc");
    expect(post!.authorDisplayName).toBe("ザビマル トレカ速報");
    // 本文（改行が保持され、店舗・締切を含む）
    expect(post!.bodyText).toContain("ドラゴンスターで「世界最強の戦士」の抽選開始されました");
    expect(post!.bodyText).toContain("8/5(水)23:59");
    // 本文内リンク（t.co）
    expect(post!.externalUrls).toContain("https://t.co/abcDEF123");
    // 画像URL（pbs.twimg.com/media を正規化＝元サイズ name=orig に統一）
    expect(post!.imageUrls).toContain("https://pbs.twimg.com/media/G5i-CIfaYAAg1wD?format=jpg&name=orig");
    // rawHtml は画像を含み、cleanedHtml は画像を含まない
    expect(post!.rawHtml).toContain("pbs.twimg.com/media");
    expect(post!.cleanedHtml).not.toContain("<img");
    expect(post!.cleanedHtml).not.toContain("pbs.twimg.com/media");
  });

  it("multi-product: 複数商品行が本文に保持される（分割自体は Phase 2）", () => {
    const post = parseTweetArticle(fixture("multi-product.html"));
    expect(post).not.toBeNull();
    expect(post!.tweetId).toBe("1987086713177469065");
    expect(post!.bodyText).toContain("世界最強の戦士");
    expect(post!.bodyText).toContain("STORY BOOSTER 01");
    expect(post!.imageUrls).toEqual([]);
  });

  it("article でない HTML は null", () => {
    expect(parseTweetArticle("<div>not a tweet</div>")).toBeNull();
  });
});
