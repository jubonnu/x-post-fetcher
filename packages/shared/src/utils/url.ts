import type { UrlType } from "../types.ts";
import type { ClassifiedUrl } from "../schemas.ts";

/**
 * URL ユーティリティ（Phase 2: 明確な種別のルール分類まで。
 * リダイレクト追跡による最終URL解決は Phase 4）。
 */

/** URL からホスト名を抽出（scheme 無し・末尾省略の表示テキストにも対応） */
export function hostFromText(s: string): string | null {
  if (!s) return null;
  const cleaned = s.trim().replace(/^https?:\/\//i, "");
  const m = cleaned.match(/^([a-z0-9.-]+\.[a-z]{2,})/i);
  return m ? m[1].replace(/^www\./i, "").toLowerCase() : null;
}

/** http(s) の絶対URLか */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** URL/表示テキストから正式な domain（ホスト）を抽出。失敗時 null */
export function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return hostFromText(url);
  }
}

/**
 * URL（または展開後の表示テキスト）を明確な種別に分類する。
 * t.co の href は分類できないため、呼び出し側は可能なら「表示テキスト（展開後ドメイン）」を渡す。
 */
export function classifyUrl(raw: string): ClassifiedUrl {
  const host = hostFromText(raw);
  const s = raw.toLowerCase();

  let urlType: UrlType = "unknown";

  if (s.includes("apps.apple.com") || s.includes("play.google.com")) {
    urlType = "app_download";
  } else if (/pbs\.twimg\.com\/media/.test(s)) {
    urlType = "image";
  } else if (/(?:^|\.)(x|twitter)\.com/.test(host ?? "") && /\/status\//.test(s)) {
    urlType = "x_post";
  } else if (/membercard\.jp|会員|member|signup|register/.test(s)) {
    urlType = "membership_registration";
  } else if (/docs\.google\.com\/forms|forms\.gle|passmarket|livepocket|select-type|cloud-pass/.test(s)) {
    urlType = "application";
  } else if (/pokemoncenter-online\.com\/news|\/news\//.test(s)) {
    urlType = "official_information";
  }

  return { originalUrl: raw, domain: host, urlType };
}

/** 画像URLを image 種別として分類 */
export function classifyImageUrl(url: string): ClassifiedUrl {
  return { originalUrl: url, domain: hostFromText(url), urlType: "image" };
}
