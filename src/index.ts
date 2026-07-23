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
// 未ログインで初回描画される件数（概ね 14 前後）が実質の上限。
// スクロールしても増えない（ログイン壁が挿入される）ため、初回描画分を最大まで取得する。
// 実際に読み込めた件数がこれ未満なら、その全件を返す。
const MAX_POSTS = 14;

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

// タイムラインの投稿を包む article は、状態によって2種類ある。
//  - 未ログイン: Schema.org SSR 版 … <article data-tweet-id="...">
//  - ログイン時: React アプリ版      … <article data-testid="tweet">
const ARTICLE_SELECTOR = 'article[data-testid="tweet"], article[data-tweet-id]';

/**
 * 投稿内の折り畳み/翻訳ボタンを全て押して、本文を「日本語の全文」で表示させる。
 *  - 「さらに表示 / Show more」… 長文の折り畳み展開（その場で展開、ページ遷移なし）
 *  - 「原文 / Show original」  … 自動翻訳された投稿を原文（日本語）に戻す
 *    （ログインアカウントの表示言語が日本語以外だと投稿が自動翻訳されるため）
 *
 * ※ 「翻訳 / Translate post」は押さない（英語へ翻訳してしまうため正規表現から除外）。
 * ※ Playwright の locator.click() はアクション可能性チェックで弾かれることがあるため、
 *   page.evaluate 内で各ボタンの .click() を直接呼ぶ。
 */
async function expandAllPosts(page: Page): Promise<void> {
  const MAX_ROUNDS = 12;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const clicked = await page.evaluate((selector) => {
      let n = 0;
      for (const article of document.querySelectorAll(selector)) {
        for (const el of article.querySelectorAll('button, span[role="button"]')) {
          const t = (el as HTMLElement).innerText || "";
          if (/さらに表示|Show more|原文|Show original/.test(t)) {
            (el as HTMLElement).click();
            n++;
          }
        }
      }
      return n;
    }, ARTICLE_SELECTOR);
    if (clicked === 0) break;
    await page.waitForTimeout(600);
  }
}

/**
 * 現在 DOM に描画されている投稿を抽出する（expandAllPosts で展開済みが前提）。
 * ログイン時(React)・未ログイン時(SSR)の両方の DOM 構造に対応する。
 */
async function extractVisiblePosts(page: Page): Promise<Post[]> {
  return page.$$eval(ARTICLE_SELECTOR, (articles) => {
    const results: Array<{
      id: string;
      date: string;
      url: string;
      text: string;
      html: string;
    }> = [];

    // article を複製し、画像・動画などのメディア要素を除去した HTML を返す。
    // （画像は不要なので保存 HTML から <img>/<video> やメディアコンテナ・画像URLメタを取り除く）
    const cleanHtml = (article: Element): string => {
      const clone = article.cloneNode(true) as HTMLElement;
      const removeSelectors = [
        "img",
        "video",
        "source",
        'meta[itemprop="image"]',
        'meta[itemprop="thumbnailUrl"]',
        'meta[itemprop="contentUrl"]',
        '[data-testid="tweetPhoto"]',
        '[data-testid="videoPlayer"]',
        '[data-testid="videoComponent"]',
        '[data-testid="previewInterstitial"]',
        '[data-testid="card.layoutLarge.media"]',
        '[data-testid="card.layoutSmall.media"]',
      ];
      clone.querySelectorAll(removeSelectors.join(",")).forEach((el) => el.remove());
      // インライン背景画像も除去
      clone.querySelectorAll('[style*="background-image"]').forEach((el) => {
        (el as HTMLElement).style.backgroundImage = "";
      });
      return clone.outerHTML;
    };

    for (const article of articles) {
      if (article.getAttribute("data-testid") === "tweet") {
        // --- React アプリ版（ログイン時）---
        const timeEl = article.querySelector("time");
        const anchor = timeEl?.closest('a[href*="/status/"]') as HTMLAnchorElement | null;
        const href = anchor?.getAttribute("href") ?? "";
        const idMatch = href.match(/\/status\/(\d+)/);
        if (!idMatch) continue; // 投稿本体でない article はスキップ
        const id = idMatch[1];
        const url = "https://x.com" + href.split("/photo/")[0];
        const date = timeEl?.getAttribute("datetime") ?? "";
        const textEl = article.querySelector('[data-testid="tweetText"]') as HTMLElement | null;
        const text = (textEl?.innerText ?? "").trim();
        results.push({ id, date, url, text, html: cleanHtml(article) });
      } else {
        // --- Schema.org SSR 版（未ログイン時）---
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
        results.push({ id, date, url, text, html: cleanHtml(article) });
      }
    }
    return results;
  });
}

/**
 * タイムラインをスクロールしながら投稿を集め、最新 MAX_POSTS 件を返す。
 *
 * - ログインなし: 初回描画分（十数件）で頭打ち。スクロールしても増えない。
 * - ログインあり(auth.json): スクロールで過去へ遡り、連続した最新 MAX_POSTS 件を取得できる。
 *
 * 毎ループで「さらに表示」を展開 → 抽出 → 下へスクロール、を繰り返す。
 * 新規投稿が増えなくなった（= これ以上遡れない）ら打ち切る。
 */
async function collectPosts(page: Page): Promise<Post[]> {
  const collected = new Map<string, Post>();
  const MAX_SCROLLS = 40;
  let noGrowthStreak = 0;

  for (let i = 0; i < MAX_SCROLLS; i++) {
    await expandAllPosts(page);

    const before = collected.size;
    for (const p of await extractVisiblePosts(page)) {
      if (p.id && !collected.has(p.id)) collected.set(p.id, p);
    }

    if (collected.size >= MAX_POSTS) break;

    // 増えなかったら、これ以上読み込めない可能性。数回連続したら打ち切る。
    if (collected.size === before) {
      if (++noGrowthStreak >= 3) break;
    } else {
      noGrowthStreak = 0;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
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

  // 画像・動画・フォントは不要なのでダウンロードをブロックする（通信削減・高速化）。
  // ※ script / xhr / fetch は React アプリの動作に必須なのでブロックしない。
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image" || type === "media" || type === "font") {
      return route.abort();
    }
    return route.continue();
  });

  const page: Page = await context.newPage();

  try {
    console.log(`[info] アクセス中: ${PROFILE_URL}`);
    await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    // タイムラインの投稿が描画されるまで待機（React/SSR どちらの DOM でも可）
    try {
      await page.waitForSelector(ARTICLE_SELECTOR, { timeout: 30000 });
    } catch {
      const url = page.url();
      if (/\/login|\/i\/flow\/login/.test(url)) {
        throw new Error(
          "ログインページへリダイレクトされました。auth.json（ログイン済み storageState）を用意してください。"
        );
      }
      throw new Error("投稿要素が見つかりませんでした。ページ構造の変更、またはレート制限の可能性があります。");
    }

    // スクロールしながら「さらに表示」を展開しつつ最新 MAX_POSTS 件を収集する
    console.log(`[info] 投稿を収集中（最大 ${MAX_POSTS} 件）...`);
    const posts = await collectPosts(page);
    console.log(`[info] ${posts.length} 件を収集しました。`);

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
