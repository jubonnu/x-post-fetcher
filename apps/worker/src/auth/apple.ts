import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { sha256Hex } from "./hash.ts";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = new URL("https://appleid.apple.com/auth/keys");

/**
 * Apple JWKS（`https://appleid.apple.com/auth/keys`）のリモート鍵セット。
 * jose の `createRemoteJWKSet` が kid 単位の鍵選択とキャッシュ（未知kid時のみ
 * cooldown間隔で再取得）を内部で行う。Workerのisolateが生きている間は
 * このモジュール内キャッシュを使い回す。
 *
 * Node実装のjoseは`node:https`を直接使うため、テストでは`fetch`の差し替えでは
 * 傍受できない。そのため`__setAppleJwksResolverForTests`でこの鍵解決関数自体を
 * 差し替え可能にしている（本番コードパスには影響しない、テスト専用のフック）。
 */
let cachedJwks: JWTVerifyGetKey | undefined;
let jwksResolverOverrideForTests: JWTVerifyGetKey | undefined;

function getAppleJwks(): JWTVerifyGetKey {
  if (jwksResolverOverrideForTests) return jwksResolverOverrideForTests;
  if (!cachedJwks) {
    cachedJwks = createRemoteJWKSet(APPLE_JWKS_URL, {
      cooldownDuration: 60_000,
    });
  }
  return cachedJwks;
}

/** テスト専用: 実際のApple JWKSエンドポイントの代わりに使う鍵解決関数を設定する。 */
export function __setAppleJwksResolverForTests(resolver: JWTVerifyGetKey | undefined): void {
  jwksResolverOverrideForTests = resolver;
}

export class AppleIdentityTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleIdentityTokenError";
  }
}

export interface VerifyAppleIdentityTokenInput {
  identityToken: string;
  /** クライアントが認可リクエスト時に使用した生のnonce。渡された場合のみnonce検証を行う。 */
  rawNonce?: string;
  /** audience検証に使うApple Client ID（Bundle Identifier）。環境変数 APPLE_CLIENT_ID から解決する。 */
  appleClientId: string;
}

export interface AppleIdentityTokenClaims {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  isPrivateEmail?: boolean;
}

function readBoolClaim(value: JWTPayload[string]): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/**
 * Sign in with Apple の identityToken を検証する。
 *
 * 検証項目:
 * - alg: RS256のみ許可（アルゴリズム混同攻撃対策として明示的に固定）
 * - kid: JWKS内の一致する鍵で署名検証（未知kid・署名不一致は失敗）
 * - iss: `https://appleid.apple.com` と完全一致
 * - aud: 呼び出し元が渡す `appleClientId`（Bundle Identifier）と完全一致
 * - exp: 期限切れを拒否（jose標準機能）
 * - iat: クレームとして存在することを必須とする
 * - sub: クレームとして存在することを必須とする（`user_identities.providerUserId`として使用）
 * - nonce: `rawNonce` が渡された場合、そのSHA-256ハッシュがトークン内 `nonce` と一致することを確認
 *   （トークンのリレー/再送攻撃対策）
 */
export async function verifyAppleIdentityToken(
  input: VerifyAppleIdentityTokenInput
): Promise<AppleIdentityTokenClaims> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(input.identityToken, getAppleJwks(), {
      issuer: APPLE_ISSUER,
      audience: input.appleClientId,
      algorithms: ["RS256"],
    });
    payload = result.payload;
  } catch (e) {
    throw new AppleIdentityTokenError(
      `identityTokenの検証に失敗しました: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (typeof payload.iat !== "number") {
    throw new AppleIdentityTokenError("identityTokenにiatが含まれていません");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new AppleIdentityTokenError("identityTokenにsubが含まれていません");
  }

  if (input.rawNonce !== undefined) {
    const expectedNonce = await sha256Hex(input.rawNonce);
    if (payload.nonce !== expectedNonce) {
      throw new AppleIdentityTokenError("nonceが一致しません");
    }
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    emailVerified: readBoolClaim(payload.email_verified as JWTPayload[string]),
    isPrivateEmail: readBoolClaim(payload.is_private_email as JWTPayload[string]),
  };
}
