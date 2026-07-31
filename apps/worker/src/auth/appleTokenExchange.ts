import { SignJWT, importPKCS8 } from "jose";

/**
 * Apple authorizationCode交換・トークン失効（Mobile-G2A-Hardening）。
 *
 * 重要: このモジュールが実際にApple側へネットワークアクセスするのは
 * `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` / `APPLE_TOKEN_ENCRYPTION_KEY` が
 * すべて設定されている場合のみ（`resolveAppleTokenExchangeConfig`が`undefined`を返せば
 * 呼び出し側は丸ごとスキップする）。正式な.p8鍵が無い現時点では、本番運用でこれらの関数が
 * 実行されることは無い。テストでは`fetchImpl`を注入してApple本物のAPIへは一切通信しない。
 */

export class AppleTokenExchangeError extends Error {
  appleError?: string;
  constructor(message: string, appleError?: string) {
    super(message);
    this.name = "AppleTokenExchangeError";
    this.appleError = appleError;
  }
}

export class AppleTokenRevokeError extends Error {
  appleError?: string;
  constructor(message: string, appleError?: string) {
    super(message);
    this.name = "AppleTokenRevokeError";
    this.appleError = appleError;
  }
}

const APPLE_TOKEN_ENDPOINT = "https://appleid.apple.com/auth/token";
const APPLE_REVOKE_ENDPOINT = "https://appleid.apple.com/auth/revoke";
const APPLE_AUDIENCE = "https://appleid.apple.com";
/** Client Secret JWTの有効期限。Appleは最大6ヶ月まで許容するが、都度短命で発行すれば十分。 */
const CLIENT_SECRET_TTL_SECONDS = 5 * 60;

export interface AppleClientSecretConfig {
  teamId: string;
  keyId: string;
  /** .p8ファイルの内容（PEM形式、PKCS8）。Cloudflare Secretsから読み込む想定。 */
  privateKeyPem: string;
  /** APPLE_CLIENT_ID（Bundle Identifier）。 */
  clientId: string;
}

/**
 * Apple向けclient_secret（ES256署名JWT）を生成する。
 * iss=teamId, sub=clientId, aud=https://appleid.apple.com, kid=keyId。
 * 秘密鍵そのものはログへ一切出力しない。
 */
export async function generateAppleClientSecret(config: AppleClientSecretConfig): Promise<string> {
  let privateKey;
  try {
    privateKey = await importPKCS8(config.privateKeyPem, "ES256");
  } catch (e) {
    throw new AppleTokenExchangeError(
      `APPLE_PRIVATE_KEYの読み込みに失敗しました: ${e instanceof Error ? e.message : "unknown error"}`
    );
  }

  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: config.keyId })
    .setIssuer(config.teamId)
    .setSubject(config.clientId)
    .setAudience(APPLE_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + CLIENT_SECRET_TTL_SECONDS)
    .sign(privateKey);
}

export interface AppleFetchDeps {
  /** テスト時にApple本物のAPIへの通信を避けるための注入ポイント。省略時はグローバルfetch。 */
  fetchImpl?: typeof fetch;
}

export interface AppleTokenExchangeResult {
  appleRefreshToken: string;
  expiresIn: number;
}

/**
 * authorizationCodeをApple Refresh Tokenへ交換する。
 * authorizationCodeはApple側で一度使用すると無効になる（単発利用）。交換に失敗した場合、
 * 同じコードでの再試行はできないため、この関数はリトライしない
 * （ログイン自体は失敗させず、呼び出し側でベストエフォートとして無視する設計）。
 */
export async function exchangeAppleAuthorizationCode(
  authorizationCode: string,
  clientSecret: string,
  config: { clientId: string },
  deps: AppleFetchDeps = {}
): Promise<AppleTokenExchangeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: clientSecret,
    code: authorizationCode,
    grant_type: "authorization_code",
  });

  const res = await fetchImpl(APPLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const json = (await res.json().catch(() => ({}))) as { refresh_token?: string; expires_in?: number; error?: string };

  if (!res.ok || !json.refresh_token) {
    throw new AppleTokenExchangeError(`Apple token交換に失敗しました (status=${res.status})`, json.error);
  }

  return { appleRefreshToken: json.refresh_token, expiresIn: json.expires_in ?? 0 };
}

export interface AppleTokenRevokeResult {
  /** Apple側が「既に無効」と回答した場合はtrue（目的は達成済みとして成功扱いにする）。 */
  alreadyInvalid: boolean;
}

/**
 * Apple Refresh Tokenを失効させる。ネットワーク一時障害等での再試行は呼び出し側
 * （アカウント削除フロー、`account_deletion_requests.appleRevocationStatus`）の責務。
 */
export async function revokeAppleToken(
  appleRefreshToken: string,
  clientSecret: string,
  config: { clientId: string },
  deps: AppleFetchDeps = {}
): Promise<AppleTokenRevokeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: clientSecret,
    token: appleRefreshToken,
    token_type_hint: "refresh_token",
  });

  const res = await fetchImpl(APPLE_REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (res.ok) {
    return { alreadyInvalid: false };
  }

  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (json.error === "invalid_grant") {
    // すでに失効済み/不正なトークン = 目的（失効している状態）は達成済みとして成功扱いにする
    return { alreadyInvalid: true };
  }

  throw new AppleTokenRevokeError(`Apple token失効に失敗しました (status=${res.status})`, json.error);
}
