import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdir, writeFile, access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PoC: Xアカウントの最新投稿を Playwright で取得する。
 * 対象: https://x.com/Zabi_pokeka
 *
 * - 最新5件の投稿を取得
 * - Console 表示 / HTML 保存 / JSON 保存
 *
 * 注意: X はプロフィール閲覧にログインを要求する場合がある。
 *   その場合はログイン済みの storageState を ./auth.json に用意すると安定する。
 *   (生成例: `npx playwright open --save-storage=auth.json https://x.com/login` でログイン後に保存)
 */

const TARGET_USER = "Zabi_pokeka";
const PROFILE_URL = `https://x.com/${TARGET_USER}`;
const MAX_POSTS = 5;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUTPUT_DIR = resolve(ROOT, "output");
const AUTH_STATE = resolve(ROOT, "auth.json");

interface Post {
  id: string;
  date: string;
  url: string;
  text: string;
  html: string;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, FS.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * タイムライン上の長文投稿は「さらに表示」ボタンで折り畳まれている。
 * このボタンは <button onclick> でその場で全文を展開する（ページ遷移しない）ため、
 * 抽出前に全て押して本文を展開しておく。
 *
 * ※ Playwright の locator.click() は「アクション可能性」チェックのため、画像と重なる等の
 *   一部ボタン（特に画像付き長文）でクリックが弾かれることがある。
 *   そこで page.evaluate 内で各ボタンの .click() を直接呼び、確実に全展開する。
 */
async function expandAllPosts(page: Page): Promise<void> {
  const MAX_ROUNDS = 10;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const clicked = await page.evaluate(() => {
      let n = 0;
      for (const article of document.querySelectorAll("article[data-tweet-id]")) {
        for (const btn of article.querySelectorAll("button")) {
          if (/さらに表示/.test((btn as HTMLElement).innerText)) {
            (btn as HTMLButtonElement).click();
            n++;
          }
        }
      }
      return n;
    });
    if (clicked === 0) break;
    await page.waitForTimeout(500);
  }
}

/**
 * タイムラインから投稿を抽出する。expandAllPosts で展開済みなので本文は全文。
 * X は UA によって Schema.org 構造化データ付きの SSR を返し、各投稿は
 * <article data-tweet-id="..."> + 直下の <meta itemprop="datePublished/url/articleBody"> で表現される。
 */
async function collectPosts(page: Page): Promise<Post[]> {
  const batch = await page.$$eval("article[data-tweet-id]", (articles) => {
    const results: Array<{
      id: string;
      date: string;
      url: string;
      text: string;
      html: string;
    }> = [];

    for (const article of articles) {
      const get = (prop: string) =>
        article.querySelector(":scope > meta[itemprop='" + prop + "']")?.getAttribute("content") ?? "";
      const id = article.getAttribute("data-tweet-id") || get("identifier");
      const date = get("datePublished") || get("dateCreated");
      const url = get("url");

      // meta[articleBody] は先頭 ~229 文字の抜粋。展開後の全文は <div dir="auto"> にある。
      // 抜粋の先頭を「指紋」にして本文 div を特定し、その innerText を全文として使う。
      const excerpt = (get("articleBody") || get("text")).trim();
      const strip = (s: string) => s.replace(/\s+/g, "");
      const fingerprint = strip(excerpt).slice(0, 15);

      let text = excerpt;
      for (const el of Array.from(article.querySelectorAll("div[dir='auto']"))) {
        const full = (el as HTMLElement).innerText.trim().replace(/\s*さらに表示\s*$/, "").trim();
        if (fingerprint && strip(full).startsWith(fingerprint) && full.length >= text.length) {
          text = full;
        }
      }

      results.push({ id, date, url, text, html: article.outerHTML });
    }
    return results;
  });

  const collected = new Map<string, Post>();
  for (const p of batch) {
    if (p.id && !collected.has(p.id)) collected.set(p.id, p);
  }

  // 日時の新しい順に並べ替えて最新 MAX_POSTS 件（固定ツイートが先頭に来ても正しく最新順になる）
  const sorted = [...collected.values()].sort((a, b) => {
    const ta = a.date ? Date.parse(a.date) : 0;
    const tb = b.date ? Date.parse(b.date) : 0;
    return tb - ta;
  });

  return sorted.slice(0, MAX_POSTS);
}

function printPost(p: Post): void {
  console.log("=====================");
  console.log(`Post ID: ${p.id}`);
  console.log(`Date: ${p.date}`);
  console.log(`URL: ${p.url}`);
  console.log("");
  console.log("Text:");
  console.log(p.text || "(本文なし)");
  console.log("");
  console.log("=====================");
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const browser: Browser = await chromium.launch({
    headless: true,
  });

  const hasAuth = await fileExists(AUTH_STATE);
  if (hasAuth) {
    console.log(`[info] auth.json を検出しました。ログイン状態で取得します。`);
  } else {
    console.log(`[info] auth.json なし。未ログインで取得を試みます。`);
  }

  const context: BrowserContext = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    locale: "ja-JP",
    ...(hasAuth ? { storageState: AUTH_STATE } : {}),
  });

  const page: Page = await context.newPage();

  try {
    console.log(`[info] アクセス中: ${PROFILE_URL}`);
    await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    // タイムラインの投稿が描画されるまで待機
    try {
      await page.waitForSelector("article[data-tweet-id]", { timeout: 30000 });
    } catch {
      const url = page.url();
      if (/\/login|\/i\/flow\/login/.test(url)) {
        throw new Error(
          "ログインページへリダイレクトされました。auth.json（ログイン済み storageState）を用意してください。"
        );
      }
      throw new Error("投稿要素が見つかりませんでした。ページ構造の変更、またはレート制限の可能性があります。");
    }

    // 「さらに表示」を全てクリックして長文投稿を展開してから抽出する
    console.log(`[info] 「さらに表示」を展開中...`);
    await expandAllPosts(page);

    const posts = await collectPosts(page);

    if (posts.length === 0) {
      console.warn("[warn] 投稿を取得できませんでした。");
      return;
    }

    // Console 表示
    for (const p of posts) printPost(p);

    // HTML 保存
    for (const p of posts) {
      const htmlPath = resolve(OUTPUT_DIR, `post-${p.id}.html`);
      await writeFile(htmlPath, p.html, "utf-8");
      console.log(`[saved] ${htmlPath}`);
    }

    // JSON 保存 (html は除外して本文中心の JSON にする)
    const jsonPath = resolve(OUTPUT_DIR, "posts.json");
    const jsonData = posts.map(({ id, date, url, text }) => ({ id, date, url, text }));
    await writeFile(jsonPath, JSON.stringify(jsonData, null, 2), "utf-8");
    console.log(`[saved] ${jsonPath}`);

    console.log(`[done] ${posts.length} 件の投稿を取得しました。`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error("[error]", err instanceof Error ? err.message : err);
  process.exit(1);
});
