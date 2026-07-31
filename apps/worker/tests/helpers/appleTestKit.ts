import { SignJWT, generateKeyPair, type JWTHeaderParameters, type JWTVerifyGetKey, type KeyLike } from "jose";

export const TEST_KID = "test-kid-1";
export const TEST_APPLE_CLIENT_ID = "com.cardhub.mobile.test";
export const TEST_APPLE_ISSUER = "https://appleid.apple.com";

export async function createAppleTestKeyPair(): Promise<{ publicKey: KeyLike; privateKey: KeyLike }> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  return { publicKey: publicKey as KeyLike, privateKey: privateKey as KeyLike };
}

/** 指定した公開鍵のみを既知のkidとして返す、テスト用のJWKS解決関数。 */
export function makeAppleJwksResolver(publicKey: KeyLike, kid: string = TEST_KID): JWTVerifyGetKey {
  return (async (protectedHeader: JWTHeaderParameters) => {
    if (protectedHeader.kid !== kid) {
      throw new Error(`unknown kid: ${String(protectedHeader.kid)}`);
    }
    return publicKey;
  }) as JWTVerifyGetKey;
}

/** JWKS取得自体が失敗する状況（ネットワーク障害等）を模したテスト用の解決関数。 */
export function makeFailingJwksResolver(): JWTVerifyGetKey {
  return (async () => {
    throw new Error("jwks fetch failed");
  }) as JWTVerifyGetKey;
}

export interface SignTestAppleTokenOptions {
  privateKey: KeyLike;
  kid?: string;
  sub?: string;
  iss?: string;
  aud?: string;
  nonce?: string;
  email?: string;
  emailVerified?: boolean;
  isPrivateEmail?: boolean;
  expiresInSeconds?: number;
  issuedAtOffsetSeconds?: number;
  omitIat?: boolean;
}

export const TEST_APPLE_SUB = "000123.testsub456789.0000";

export async function signTestAppleToken(opts: SignTestAppleTokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const iat = now + (opts.issuedAtOffsetSeconds ?? 0);
  const exp = iat + (opts.expiresInSeconds ?? 600);

  const claims: Record<string, unknown> = {};
  if (opts.email !== undefined) claims.email = opts.email;
  if (opts.emailVerified !== undefined) claims.email_verified = opts.emailVerified;
  if (opts.isPrivateEmail !== undefined) claims.is_private_email = opts.isPrivateEmail;
  if (opts.nonce !== undefined) claims.nonce = opts.nonce;

  let builder = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? TEST_KID })
    .setIssuer(opts.iss ?? TEST_APPLE_ISSUER)
    .setAudience(opts.aud ?? TEST_APPLE_CLIENT_ID)
    .setSubject(opts.sub ?? TEST_APPLE_SUB)
    .setExpirationTime(exp);

  if (!opts.omitIat) {
    builder = builder.setIssuedAt(iat);
  }

  return builder.sign(opts.privateKey);
}

/** 有効な署名済みJWTの署名部分を破壊し、署名不一致を再現する。 */
export function tamperSignature(token: string): string {
  const parts = token.split(".");
  const sig = parts[2] ?? "";
  const flipped = sig.length > 0 ? (sig[0] === "A" ? "B" : "A") + sig.slice(1) : "AAAA";
  return `${parts[0]}.${parts[1]}.${flipped}`;
}
