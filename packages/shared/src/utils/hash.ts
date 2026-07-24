/**
 * contentHash 計算（Node 24 / Cloudflare Workers 両対応）。
 * globalThis.crypto.subtle（Web Crypto）を使うため isomorphic。
 */

/** 文字列の SHA-256 を16進で返す */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 投稿本文から contentHash を計算する。
 * 本文の前後空白のみ正規化（改行・内部空白は保持）して、意味的な変更を検知する。
 */
export async function computeContentHash(bodyRaw: string): Promise<string> {
  return sha256Hex(bodyRaw.trim());
}
