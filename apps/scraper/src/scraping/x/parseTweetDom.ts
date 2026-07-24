import { parseHTML } from "linkedom";
import {
  MEDIA_REMOVE_SELECTORS,
  TWEET_MEDIA_IMG,
  TWEET_TEXT_SELECTOR,
  USER_NAME_SELECTOR,
} from "./selectors.ts";

/**
 * 1件の投稿 article HTML から生データを抽出する純関数。
 * 本番（Playwright が取得した outerHTML）と fixture テストの両方で同じ関数を使う。
 * linkedom で DOM 化するためブラウザ不要。
 */
export interface ExternalLink {
  href: string;
  text: string;
}

export interface RawPost {
  tweetId: string;
  authorId: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  bodyText: string;
  publishedAt: string | null; // ISO8601
  sourceUrl: string;
  externalUrls: string[];
  /** リンクの href と表示テキスト（展開ドメインを含む）。URL分類に使う */
  externalLinks: ExternalLink[];
  imageUrls: string[];
  rawHtml: string;
  cleanedHtml: string;
}

/** innerText 相当のテキスト抽出（ブロック要素/BR で改行、img は alt=絵文字を採用） */
function extractText(el: Element): string {
  let text = "";
  el.childNodes.forEach((n: any) => {
    if (n.nodeType === 3) {
      text += n.textContent ?? "";
    } else if (n.nodeType === 1) {
      const tag = (n.tagName as string).toUpperCase();
      if (tag === "BR") {
        text += "\n";
      } else if (tag === "IMG") {
        text += n.getAttribute("alt") ?? "";
      } else {
        const inner = extractText(n as Element);
        if (tag === "DIV" || tag === "P") text += inner + "\n";
        else text += inner;
      }
    }
  });
  return text;
}

function normalizeText(s: string): string {
  return s.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}

function buildCleanedHtml(article: Element): string {
  const clone = article.cloneNode(true) as Element;
  clone.querySelectorAll(MEDIA_REMOVE_SELECTORS.join(",")).forEach((el: Element) => el.remove());
  clone.querySelectorAll('[style*="background-image"]').forEach((el: any) => {
    el.setAttribute("style", (el.getAttribute("style") ?? "").replace(/background-image[^;]*;?/gi, ""));
  });
  return (clone as any).outerHTML;
}

export function parseTweetArticle(html: string): RawPost | null {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const article = document.querySelector('article[data-testid="tweet"], article[data-tweet-id]');
  if (!article) return null;

  const rawHtml = (article as any).outerHTML as string;
  const cleanedHtml = buildCleanedHtml(article);

  if (article.getAttribute("data-testid") === "tweet") {
    return parseReactArticle(article, rawHtml, cleanedHtml);
  }
  return parseSsrArticle(article, rawHtml, cleanedHtml);
}

/** ログイン時（React アプリ版 DOM） */
function parseReactArticle(article: Element, rawHtml: string, cleanedHtml: string): RawPost | null {
  const timeEl = article.querySelector("time");
  const anchor = timeEl?.closest('a[href*="/status/"]') as Element | null;
  const href = anchor?.getAttribute("href") ?? "";
  const idMatch = href.match(/\/status\/(\d+)/);
  if (!idMatch) return null;

  const tweetId = idMatch[1];
  const authorUsername = href.split("/").filter(Boolean)[0] ?? null; // /{username}/status/{id}
  const sourceUrl = "https://x.com" + href.split("/photo/")[0];
  const publishedAt = timeEl?.getAttribute("datetime") ?? null;

  const nameEl = article.querySelector(USER_NAME_SELECTOR);
  let authorDisplayName: string | null = null;
  if (nameEl) {
    const full = extractText(nameEl as Element).trim();
    authorDisplayName = full.split("@")[0].trim() || null;
  }

  const textEl = article.querySelector(TWEET_TEXT_SELECTOR);
  const bodyText = textEl ? normalizeText(extractText(textEl as Element)) : "";
  const externalLinks = collectLinks(article);

  return {
    tweetId,
    authorId: null, // React DOM からは数値ID を確実には取得できない
    authorUsername,
    authorDisplayName,
    bodyText,
    publishedAt,
    sourceUrl,
    externalUrls: externalLinks.map((l) => l.href),
    externalLinks,
    imageUrls: collectImageUrls(article),
    rawHtml,
    cleanedHtml,
  };
}

/** 未ログイン時（Schema.org SSR 版 DOM） */
function parseSsrArticle(article: Element, rawHtml: string, cleanedHtml: string): RawPost | null {
  const metas = Array.from(article.querySelectorAll("meta")) as Element[];
  const metaBy = (prop: string, pred?: (v: string) => boolean): string | null => {
    for (const m of metas) {
      if (m.getAttribute("itemprop") === prop) {
        const v = m.getAttribute("content") ?? "";
        if (!pred || pred(v)) return v;
      }
    }
    return null;
  };

  const tweetId = article.getAttribute("data-tweet-id") || metaBy("identifier", (v) => /^\d+$/.test(v));
  if (!tweetId) return null;

  const sourceUrl = metaBy("url", (v) => v.includes("/status/")) ?? "";
  const publishedAt = metaBy("datePublished") ?? metaBy("dateCreated");
  const authorUsername = metaBy("alternateName");
  const authorId = metaBy("identifier", (v) => /^\d+$/.test(v) && v !== tweetId);

  // 展開後の全文は <div dir="auto">。articleBody 抜粋の先頭を指紋にして特定。
  const excerpt = (metaBy("articleBody") || metaBy("text") || "").trim();
  const strip = (s: string) => s.replace(/\s+/g, "");
  const fingerprint = strip(excerpt).slice(0, 15);
  let bodyText = excerpt;
  for (const el of Array.from(article.querySelectorAll("div[dir='auto']")) as Element[]) {
    const full = normalizeText(extractText(el)).replace(/\s*さらに表示\s*$/, "").trim();
    if (fingerprint && strip(full).startsWith(fingerprint) && full.length >= bodyText.length) {
      bodyText = full;
    }
  }

  const externalLinks = collectLinks(article);
  return {
    tweetId,
    authorId,
    authorUsername,
    authorDisplayName: metaBy("name"),
    bodyText,
    publishedAt,
    sourceUrl: sourceUrl || (authorUsername ? `https://x.com/${authorUsername}/status/${tweetId}` : ""),
    externalUrls: externalLinks.map((l) => l.href),
    externalLinks,
    imageUrls: collectImageUrls(article),
    rawHtml,
    cleanedHtml,
  };
}

/** 本文内リンク（t.co や外部http）を href と表示テキスト付きで収集 */
function collectLinks(article: Element): ExternalLink[] {
  const seen = new Set<string>();
  const links: ExternalLink[] = [];
  for (const a of Array.from(article.querySelectorAll("a[href]")) as Element[]) {
    const href = a.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href)) continue;
    if (/^https?:\/\/(x|twitter)\.com\//i.test(href) && /\/status\/|\/photo\//.test(href)) continue; // 自己リンク除外
    if (seen.has(href)) continue;
    seen.add(href);
    links.push({ href, text: ((a as any).textContent ?? "").trim() });
  }
  return links;
}

/**
 * pbs.twimg.com/media のURLを正規化する。
 * `/media/<id>.jpg` や `/media/<id>?format=webp&name=medium` など表示バリアントを、
 * **元サイズ（name=orig）** の一意なURLへ統一し、size違いを重複排除できるようにする。
 * （画像ID + format をキーにする。format は ?format= か拡張子から決定、無ければ jpg）
 */
function canonicalizeMediaUrl(u: string): string {
  const idMatch = u.match(/pbs\.twimg\.com\/media\/([A-Za-z0-9_-]+)/i);
  if (!idMatch) return u;
  const id = idMatch[1];
  let format = "jpg";
  const fmtQuery = u.match(/[?&]format=(\w+)/i);
  const extMatch = u.match(/pbs\.twimg\.com\/media\/[A-Za-z0-9_-]+\.(\w+)/i);
  if (fmtQuery) format = fmtQuery[1].toLowerCase();
  else if (extMatch) format = extMatch[1].toLowerCase();
  return `https://pbs.twimg.com/media/${id}?format=${format}&name=orig`;
}

/** srcset 文字列からURL部分だけを取り出す（"url 1x, url2 2x" / "url 300w, ..." 両対応） */
function parseSrcset(srcset: string): string[] {
  return srcset
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/**
 * 投稿メディア画像URLを収集（アバター・絵文字・プロフィール画像は除外、重複排除）。
 * 画像リソースを route でブロックしていても、DOM上にURL（src/srcset/meta/背景）が
 * 残っていれば抽出できる。優先順: img[src] → img[srcset] → source[srcset] → meta[image] → background-image。
 */
function collectImageUrls(article: Element): string[] {
  const canonical = new Set<string>();
  const add = (raw: string | null | undefined) => {
    if (raw && TWEET_MEDIA_IMG.test(raw)) canonical.add(canonicalizeMediaUrl(raw));
  };

  // 1. <img src> / <img srcset>
  for (const img of Array.from(article.querySelectorAll("img")) as Element[]) {
    add(img.getAttribute("src"));
    for (const u of parseSrcset(img.getAttribute("srcset") ?? "")) add(u);
  }
  // 2. <source srcset>（<picture>）
  for (const s of Array.from(article.querySelectorAll("source")) as Element[]) {
    for (const u of parseSrcset(s.getAttribute("srcset") ?? "")) add(u);
  }
  // 3. SSR の meta[itemprop=image]
  for (const m of Array.from(article.querySelectorAll('meta[itemprop="image"]')) as Element[]) {
    add(m.getAttribute("content"));
  }
  // 4. background-image: url(...)
  for (const el of Array.from(article.querySelectorAll('[style*="background-image"]')) as Element[]) {
    const style = el.getAttribute("style") ?? "";
    const m = style.match(/url\(["']?([^"')]+)["']?\)/i);
    if (m) add(m[1]);
  }

  return [...canonical];
}
