import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTweetArticle } from "../src/scraping/x/parseTweetDom.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(resolve(here, "fixtures", name), "utf-8");
const imgs = (name: string) => parseTweetArticle(fixture(name))!.imageUrls;

describe("imageUrls 抽出", () => {
  it("React DOM の img[src=pbs/media]（format=webp&name=medium）を name=orig に正規化", () => {
    // 画像リソースが route でブロックされていても、DOM に URL があれば抽出できる
    expect(imgs("image-react.html")).toEqual([
      "https://pbs.twimg.com/media/G5i-CIfaYAAg1wD?format=webp&name=orig",
    ]);
  });

  it("SSR の meta[itemprop=image] から抽出", () => {
    expect(imgs("image-ssr.html")).toEqual([
      "https://pbs.twimg.com/media/G3x2WRWWwAAKA2x?format=jpg&name=orig",
    ]);
  });

  it("srcset だけに画像URLがある場合も抽出（size違いは1つに正規化）", () => {
    expect(imgs("image-srcset.html")).toEqual([
      "https://pbs.twimg.com/media/AbCdEf12345?format=jpg&name=orig",
    ]);
  });

  it("プロフィール画像(profile_images)と絵文字SVG(abs/emoji)は除外し空になる", () => {
    expect(imgs("image-excluded.html")).toEqual([]);
  });

  it("同じ画像が複数箇所（src/srcset/source, size違い）でも重複排除して1件", () => {
    expect(imgs("image-duplicate.html")).toEqual([
      "https://pbs.twimg.com/media/XyZ99AbCdEf?format=jpg&name=orig",
    ]);
  });

  it("画像URLは rawHtml に残り cleanedHtml からは除去される（保存方針の維持）", () => {
    const post = parseTweetArticle(fixture("image-react.html"))!;
    expect(post.rawHtml).toContain("pbs.twimg.com/media");
    expect(post.cleanedHtml).not.toContain("<img");
    expect(post.cleanedHtml).not.toContain("pbs.twimg.com/media");
  });

  it("画像が無い投稿でも imageUrls は空配列で成功（保存は継続）", () => {
    const post = parseTweetArticle(fixture("multi-product.html"))!;
    expect(post.imageUrls).toEqual([]);
    expect(post.tweetId).toBeTruthy();
  });
});
