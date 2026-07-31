/**
 * RevenueCat Webhook認証（Mobile-G4、12章 + Hardening改訂）。
 *
 * 1. Authorization headerの一致検証（必須）— RevenueCat Dashboardの「Authorization header」
 *    設定機能で送られる固定値。REVENUECAT_WEBHOOK_AUTH_HEADER未設定なら呼び出し側が
 *    BILLING_NOT_CONFIGUREDとして扱う。
 * 2. HMAC-SHA256署名検証（REVENUECAT_WEBHOOK_HMAC_SECRETが設定されている場合のみ、
 *    Authorization header検証に加えて必須）— RevenueCat公式のWebhook署名形式のみを受理する:
 *      Header: X-RevenueCat-Webhook-Signature
 *      Value : t=<unix_timestamp>,v1=<hmac_sha256_hex>
 *      署名対象: `<unix_timestamp>.<raw_json_body>`
 *    独自の「raw bodyのみに対する署名」等、この形式以外は一切受理しない。
 */

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function verifyWebhookAuthorizationHeader(headerValue: string | undefined, expected: string): boolean {
  if (!headerValue) return false;
  // RevenueCatは "Authorization: <value>" または "Authorization: Bearer <value>" のどちらの
  // 設定も許容しているため、Bearerプレフィックスは剥がしてから比較する。
  const normalized = headerValue.startsWith("Bearer ") ? headerValue.slice("Bearer ".length) : headerValue;
  return timingSafeEqual(normalized, expected);
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const HMAC_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
const HEX_SHA256_REGEX = /^[0-9a-f]{64}$/i;

export interface VerifyHmacParams {
  secret: string;
  rawBody: string;
  /** `X-RevenueCat-Webhook-Signature`ヘッダの値。形式: `t=<unix_timestamp>,v1=<hmac_sha256_hex>` */
  signatureHeader: string | undefined;
}

function parseSignatureHeader(signatureHeader: string): { t: string; v1: string } | null {
  const parts = new Map<string, string>();
  for (const segment of signatureHeader.split(",")) {
    const eqIndex = segment.indexOf("=");
    if (eqIndex === -1) continue;
    parts.set(segment.slice(0, eqIndex).trim(), segment.slice(eqIndex + 1).trim());
  }
  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !v1) return null; // tまたはv1欠落
  return { t, v1 };
}

/**
 * RevenueCat公式のWebhook署名形式（`X-RevenueCat-Webhook-Signature: t=<ts>,v1=<hex>`、署名対象
 * `<ts>.<raw_json_body>`）のみを受理する。JSON parse前のraw bodyに対して計算する。
 * t・v1のいずれかが欠落、タイムスタンプが数値でない、5分の許容差を超える、hexが64桁の
 * 16進数として不正・長さ違いのいずれの場合も例外を投げずfalseを返す（呼び出し側は401）。
 */
export async function verifyWebhookHmacSignature(params: VerifyHmacParams): Promise<boolean> {
  const { secret, rawBody, signatureHeader } = params;
  if (!signatureHeader) return false;

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;

  const timestampMs = Number(parsed.t) * 1000;
  if (!Number.isFinite(timestampMs)) return false;
  if (Math.abs(Date.now() - timestampMs) > HMAC_TIMESTAMP_TOLERANCE_MS) return false;

  if (!HEX_SHA256_REGEX.test(parsed.v1)) return false; // 不正なhex・長さ違い

  const expected = await hmacSha256Hex(secret, `${parsed.t}.${rawBody}`);
  return timingSafeEqual(parsed.v1.toLowerCase(), expected);
}
