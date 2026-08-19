import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(here, "..", rel), "utf-8");

/**
 * 10. キーワード非該当投稿が20件続いた後に新規抽選投稿があっても、差分取得（スクロール継続・
 * 境界検出）自体は止まらず新規抽選投稿を取得できる、という要件の静的な裏付け。
 *
 * entryPurposeによるキーワードフィルタは「投稿を取得した後」（analyzePost.ts）にのみ適用され、
 * スクロール制御・境界検出（fetchTweets.ts の decideLoopIteration・postFilter.ts の
 * processPageHtmls）はentryPurposeを一切参照しない、という設計上の分離をソースコードレベルで
 * 保証する（境界検出は本人投稿全体を基準にし、キーワード非該当投稿を挟んでも前回取得地点まで
 * 正しく遡れることを担保するため）。
 */
describe("entryPurpose は差分取得の境界検出から独立している", () => {
  it("fetchTweets.ts は entryPurpose/classifyEntryPurpose を参照しない", () => {
    const content = src("src/scraping/x/fetchTweets.ts");
    expect(content).not.toMatch(/entryPurpose/i);
    expect(content).not.toContain("classifyEntryPurpose");
  });

  it("postFilter.ts は entryPurpose/classifyEntryPurpose を参照しない", () => {
    const content = src("src/scraping/x/postFilter.ts");
    expect(content).not.toMatch(/entryPurpose/i);
    expect(content).not.toContain("classifyEntryPurpose");
  });

  it("classifyEntryPurpose は analyzePost.ts（取得後の処理）からのみ呼ばれる", () => {
    const analyzePostSrc = src("src/lottery/analyzePost.ts");
    expect(analyzePostSrc).toContain("classifyEntryPurpose");
  });
});
