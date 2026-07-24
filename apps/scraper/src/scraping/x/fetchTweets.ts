import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { AUTH_STATE } from "../../paths.ts";
import { ARTICLE_SELECTOR } from "./selectors.ts";
import { parseTweetArticle, type RawPost } from "./parseTweetDom.ts";

export interface FetchOptions {
  targetUser?: string;
  maxPosts?: number;
  headless?: boolean;
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
 * 投稿内の折り畳み/翻訳ボタンを全て押して本文を「日本語の全文」で展開する。
 * page.evaluate 内で直接 .click()（locator.click のアクション可能性チェック回避）。
 */
async function expandAllPosts(page: Page): Promise<void> {
  for (let round = 0; round < 12; round++) {
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
 * X プロフィールから最新 maxPosts 件の投稿を生データで取得する。
 *  - auth.json があればログイン状態（連続した最新投稿・翻訳解除が可能）
 *  - 画像/動画/フォントはDLブロック（URLは DOM から抽出するので不要）
 *  - 抽出は parseTweetArticle（linkedom）に一本化
 */
export async function fetchTweets(opts: FetchOptions = {}): Promise<RawPost[]> {
  const targetUser = opts.targetUser ?? "Zabi_pokeka";
  const maxPosts = opts.maxPosts ?? 14;
  const profileUrl = `https://x.com/${targetUser}`;

  const browser: Browser = await chromium.launch({ headless: opts.headless ?? true });
  const hasAuth = await fileExists(AUTH_STATE);
  console.log(hasAuth ? "[fetch] auth.json 検出（ログイン状態）" : "[fetch] auth.json なし（未ログイン）");

  const context: BrowserContext = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    locale: "ja-JP",
    ...(hasAuth ? { storageState: AUTH_STATE } : {}),
  });

  // 画像は「本物のバイナリをDLせず」1x1 スタブで fulfill する。
  //   - abort だと X が画像URLをDOMへ書き込まない（背景画像はロード成功後にセットされるため）
  //   - スタブ fulfill ならロード成功扱いになり、media URL が DOM（背景/img）に入る＝抽出可能
  //   - 実画像バイナリは一切ダウンロードしない（要件: 画像バイナリDL禁止 を維持）
  // 動画・フォントは不要なので従来どおり abort。
  const STUB_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image") {
      return route.fulfill({ status: 200, contentType: "image/png", body: STUB_PNG });
    }
    if (type === "media" || type === "font") return route.abort();
    return route.continue();
  });

  const page = await context.newPage();
  try {
    console.log(`[fetch] アクセス中: ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    try {
      await page.waitForSelector(ARTICLE_SELECTOR, { timeout: 30000 });
    } catch {
      if (/\/login|\/i\/flow\/login/.test(page.url())) {
        throw new Error("ログインページへリダイレクトされました。auth.json を用意してください。");
      }
      throw new Error("投稿要素が見つかりません（構造変更 or レート制限の可能性）。");
    }

    const collected = new Map<string, RawPost>();
    let noGrowth = 0;

    for (let i = 0; i < 40; i++) {
      await expandAllPosts(page);

      const htmls: string[] = await page.$$eval(ARTICLE_SELECTOR, (els) =>
        els.map((e) => (e as HTMLElement).outerHTML)
      );

      const before = collected.size;
      for (const html of htmls) {
        // 1件の抽出失敗（DOM/画像解析エラー等）でバッチ全体を止めない
        try {
          const post = parseTweetArticle(html);
          if (post?.tweetId && !collected.has(post.tweetId)) collected.set(post.tweetId, post);
        } catch (e) {
          console.warn(`[fetch] 1件の抽出に失敗（スキップ）: ${e instanceof Error ? e.message : e}`);
        }
      }

      if (collected.size >= maxPosts) break;
      if (collected.size === before) {
        if (++noGrowth >= 3) break;
      } else {
        noGrowth = 0;
      }

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
    }

    const sorted = [...collected.values()].sort((a, b) => {
      const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return tb - ta;
    });
    return sorted.slice(0, maxPosts);
  } finally {
    await context.close();
    await browser.close();
  }
}
