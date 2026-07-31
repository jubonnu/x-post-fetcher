import { sha256Hex } from "./hash.ts";

/**
 * Refresh Tokenの生成・ハッシュ化に関する純粋関数群（DBアクセスは repositories/refreshTokenRepository.ts）。
 * 生トークンは呼び出し元（クライアントへのレスポンス）にのみ渡し、DBには保存しない。
 */

export const REFRESH_TOKEN_TTL_DAYS = 60;
export const REFRESH_TOKEN_BYTE_LENGTH = 32; // 256bit、要件の「32バイト以上」を満たす

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 暗号論的乱数によるRefresh Token（生値）を生成する。 */
export function generateRawRefreshToken(): string {
  const bytes = new Uint8Array(REFRESH_TOKEN_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** Refresh TokenのSHA-256ハッシュ（16進文字列）を計算する。DBにはこの値のみ保存する。 */
export async function hashRefreshToken(rawToken: string): Promise<string> {
  return sha256Hex(rawToken);
}

export function refreshTokenExpiryIso(fromDate: Date = new Date()): string {
  const expires = new Date(fromDate.getTime() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  return expires.toISOString();
}
