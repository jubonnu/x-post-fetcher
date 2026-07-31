import { SignJWT, decodeProtectedHeader, jwtVerify } from "jose";
import type { JwtSigningKey, JwtSigningKeys } from "./config.ts";

/**
 * CardHub独自発行のAccess Token（JWT, HS256）に関する識別子。
 * ドメイン確定前の暫定値であり、本番ドメイン決定後に見直す想定
 * （このJWTは自社Workerとモバイルアプリの間だけで解釈されるため、
 * URL形式である必要はなく暫定文字列で運用上の問題はない）。
 */
export const ACCESS_TOKEN_ISSUER = "cardhub-api";
export const ACCESS_TOKEN_AUDIENCE = "cardhub-mobile";
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export class AccessTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessTokenError";
  }
}

/** 署名・形式は正しいが期限切れの場合に区別して投げる（呼び出し側でTOKEN_EXPIREDへマッピングするため）。 */
export class AccessTokenExpiredError extends AccessTokenError {
  constructor() {
    super("Access Tokenの有効期限が切れています");
    this.name = "AccessTokenExpiredError";
  }
}

function toKeyBytes(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Access Tokenを発行する。
 * - sub: publicUserId（内部integer idは含めない）
 * - jti: トークン単位の一意ID（監査・将来の個別失効に利用可能）
 * - kid: 署名に使った鍵の世代（ローテーション用、常に最新鍵で発行）
 */
export async function signAccessToken(params: {
  publicUserId: string;
  signingKeys: JwtSigningKeys;
  ttlSeconds?: number;
}): Promise<string> {
  const { publicUserId, signingKeys, ttlSeconds = ACCESS_TOKEN_TTL_SECONDS } = params;
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", kid: signingKeys.current.kid })
    .setSubject(publicUserId)
    .setJti(crypto.randomUUID())
    .setIssuer(ACCESS_TOKEN_ISSUER)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(toKeyBytes(signingKeys.current.secret));
}

export interface AccessTokenClaims {
  publicUserId: string;
  jti: string;
}

function pickKeyForKid(kid: string | undefined, signingKeys: JwtSigningKeys): JwtSigningKey {
  if (kid && signingKeys.current.kid === kid) return signingKeys.current;
  if (kid && signingKeys.previous?.kid === kid) return signingKeys.previous;
  throw new AccessTokenError(`未知の署名鍵世代(kid)です: ${kid ?? "(なし)"}`);
}

/**
 * Access Tokenを検証する。JWTヘッダの`kid`で現行鍵/直前鍵のどちらを使うか選択し、
 * ローテーション中も両世代のトークンを検証可能にする（発行は常に現行鍵のみ）。
 */
export async function verifyAccessToken(
  token: string,
  signingKeys: JwtSigningKeys
): Promise<AccessTokenClaims> {
  let kid: string | undefined;
  try {
    ({ kid } = decodeProtectedHeader(token));
  } catch (e) {
    throw new AccessTokenError(`Access Tokenのヘッダが不正です: ${e instanceof Error ? e.message : String(e)}`);
  }

  const key = pickKeyForKid(kid, signingKeys);

  try {
    const { payload } = await jwtVerify(token, toKeyBytes(key.secret), {
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      algorithms: ["HS256"],
    });

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new AccessTokenError("Access Tokenにsubが含まれていません");
    }
    if (typeof payload.jti !== "string" || payload.jti.length === 0) {
      throw new AccessTokenError("Access Tokenにjtiが含まれていません");
    }

    return { publicUserId: payload.sub, jti: payload.jti };
  } catch (e) {
    if (e instanceof AccessTokenError) throw e;
    if (e && typeof e === "object" && "code" in e && e.code === "ERR_JWT_EXPIRED") {
      throw new AccessTokenExpiredError();
    }
    throw new AccessTokenError(`Access Tokenの検証に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }
}
