/**
 * URL ユーティリティ（Phase 1 は最小限）。
 * 最終URL解決・種別分類は Phase 2/4 で拡張する。
 */

/** URL からドメイン（ホスト名）を抽出。失敗時は null */
export function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** http(s) の絶対URLか */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
