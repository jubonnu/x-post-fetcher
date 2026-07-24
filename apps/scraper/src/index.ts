import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OUTPUT_DIR } from "./paths.ts";
import { fetchTweets } from "./scraping/x/fetchTweets.ts";
import type { RawPost } from "./scraping/x/parseTweetDom.ts";

/**
 * CLI: X の最新投稿を取得して Console 表示 + output/ に保存する（既存 `npm run fetch` 相当）。
 * DB へは送らない（送信は `npm run scrape` = jobs/fetchAndProcessTweets.ts）。
 */

function printPost(p: RawPost): void {
  console.log("=====================");
  console.log(`Post ID: ${p.tweetId}`);
  console.log(`Date: ${p.publishedAt ?? ""}`);
  console.log(`URL: ${p.sourceUrl}`);
  console.log("");
  console.log("Text:");
  console.log(p.bodyText || "(本文なし)");
  console.log("");
  console.log("=====================");
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const posts = await fetchTweets({ maxPosts: 14 });
  console.log(`[fetch] ${posts.length} 件を収集しました。`);
  if (posts.length === 0) {
    console.warn("[warn] 投稿を取得できませんでした。");
    return;
  }

  for (const p of posts) printPost(p);

  // 画像を除去した cleanedHtml を保存（従来どおり画像なしHTML）
  for (const p of posts) {
    const htmlPath = resolve(OUTPUT_DIR, `post-${p.tweetId}.html`);
    await writeFile(htmlPath, p.cleanedHtml, "utf-8");
    console.log(`[saved] ${htmlPath}`);
  }

  const jsonPath = resolve(OUTPUT_DIR, "posts.json");
  const jsonData = posts.map((p) => ({
    id: p.tweetId,
    date: p.publishedAt,
    url: p.sourceUrl,
    text: p.bodyText,
  }));
  await writeFile(jsonPath, JSON.stringify(jsonData, null, 2), "utf-8");
  console.log(`[saved] ${jsonPath}`);
  console.log(`[done] ${posts.length} 件の投稿を取得しました。`);
}

main().catch((err) => {
  console.error("[error]", err instanceof Error ? err.message : err);
  process.exit(1);
});
