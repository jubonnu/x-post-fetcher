import { classifyUrl, type ClassifiedUrl } from "@x-post/shared";
import type { ExternalLink } from "../scraping/x/parseTweetDom.ts";

/**
 * 投稿のリンク・画像URLを ClassifiedUrl[] に分類する（ルールのみ）。
 * t.co の href は分類できないため、表示テキスト（展開後ドメイン）があればそれで種別判定し、
 * originalUrl には元の href を保持する。
 */
export function classifyPostUrls(links: ExternalLink[], imageUrls: string[]): ClassifiedUrl[] {
  const out: ClassifiedUrl[] = [];
  for (const l of links) {
    const hasDomainInText = /[a-z0-9-]+\.[a-z]{2,}/i.test(l.text);
    const basis = hasDomainInText ? l.text : l.href;
    const c = classifyUrl(basis);
    out.push({ originalUrl: l.href || basis, domain: c.domain, urlType: c.urlType });
  }
  for (const img of imageUrls) {
    out.push({ originalUrl: img, domain: "pbs.twimg.com", urlType: "image" });
  }
  return out;
}
