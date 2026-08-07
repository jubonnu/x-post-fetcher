import { jwtVerify, SignJWT } from "jose";

/**
 * 管理画面（Phase 7）専用のJWT。モバイル向け`auth/accessToken.ts`とは完全に別系統
 * （issuer/audience/署名鍵いずれも共有しない）にし、片方のトークンがもう片方として
 * 誤って検証されることのないようにする。鍵ローテーションは今回のスコープ外（単一鍵のみ）。
 */
export const ADMIN_TOKEN_ISSUER = "cardhub-admin-api";
export const ADMIN_TOKEN_AUDIENCE = "cardhub-admin-web";
export const ADMIN_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export class AdminTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminTokenError";
  }
}

function toKeyBytes(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signAdminToken(params: { adminUserId: number; secret: string; ttlSeconds?: number }): Promise<string> {
  const { adminUserId, secret, ttlSeconds = ADMIN_TOKEN_TTL_SECONDS } = params;
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(adminUserId))
    .setIssuer(ADMIN_TOKEN_ISSUER)
    .setAudience(ADMIN_TOKEN_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(toKeyBytes(secret));
}

export interface AdminTokenClaims {
  adminUserId: number;
}

export async function verifyAdminToken(token: string, secret: string): Promise<AdminTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, toKeyBytes(secret), {
      issuer: ADMIN_TOKEN_ISSUER,
      audience: ADMIN_TOKEN_AUDIENCE,
      algorithms: ["HS256"],
    });

    const adminUserId = Number(payload.sub);
    if (!Number.isInteger(adminUserId) || adminUserId <= 0) {
      throw new AdminTokenError("管理者トークンにsubが含まれていません");
    }
    return { adminUserId };
  } catch (e) {
    if (e instanceof AdminTokenError) throw e;
    throw new AdminTokenError(`管理者トークンの検証に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }
}
