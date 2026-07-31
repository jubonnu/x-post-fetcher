import type { Env } from "../env.ts";
import { AuthConfigError } from "./config.ts";
import { decodeEncryptionKeyBase64, type EncryptionKeySet } from "./tokenEncryption.ts";
import type { AppleClientSecretConfig } from "./appleTokenExchange.ts";

export interface AppleTokenExchangeRuntimeConfig {
  clientSecretConfig: AppleClientSecretConfig;
  encryptionKeys: EncryptionKeySet;
}

const DEFAULT_KEY_VERSION = "v1";

/**
 * Apple authorizationCode交換・失効機能（Mobile-G2A-Hardening）の設定を解決する。
 *
 * `resolveAuthRuntimeConfig`（コア認証、fail-closed）とは独立した、ベストエフォートの
 * 副次機能として扱う。4つの必須値（APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY /
 * APPLE_TOKEN_ENCRYPTION_KEY）が1つでも欠けている、または暗号鍵の形式が不正な場合は
 * 例外を投げず`undefined`を返す（呼び出し側はこの機能全体をスキップし、ログイン・
 * アカウント削除自体は通常通り継続する）。正式な.p8鍵が無い現時点では常に`undefined`。
 */
export function resolveAppleTokenExchangeConfig(
  env: Env,
  appleClientId: string
): AppleTokenExchangeRuntimeConfig | undefined {
  const { APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY, APPLE_TOKEN_ENCRYPTION_KEY } = env;
  if (!APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY || !APPLE_TOKEN_ENCRYPTION_KEY) {
    return undefined;
  }

  try {
    const currentKeyBytes = decodeEncryptionKeyBase64(APPLE_TOKEN_ENCRYPTION_KEY, "APPLE_TOKEN_ENCRYPTION_KEY");
    const currentVersion = env.APPLE_TOKEN_ENCRYPTION_KEY_VERSION || DEFAULT_KEY_VERSION;

    let previous: EncryptionKeySet["previous"];
    if (env.APPLE_TOKEN_ENCRYPTION_KEY_PREVIOUS) {
      const previousKeyBytes = decodeEncryptionKeyBase64(
        env.APPLE_TOKEN_ENCRYPTION_KEY_PREVIOUS,
        "APPLE_TOKEN_ENCRYPTION_KEY_PREVIOUS"
      );
      const previousVersion = env.APPLE_TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION || `${DEFAULT_KEY_VERSION}-previous`;
      previous = { version: previousVersion, keyBytes: previousKeyBytes };
    }

    return {
      clientSecretConfig: {
        teamId: APPLE_TEAM_ID,
        keyId: APPLE_KEY_ID,
        privateKeyPem: APPLE_PRIVATE_KEY,
        clientId: appleClientId,
      },
      encryptionKeys: { current: { version: currentVersion, keyBytes: currentKeyBytes }, previous },
    };
  } catch (e) {
    // 値そのものは出力せず、機能を無効化するのみ（フィールド名はエラーメッセージに含まれるが値は含まれない）。
    console.error(
      JSON.stringify({
        event: "apple_token_exchange_config_invalid",
        message: e instanceof Error ? e.message : "unknown error",
      })
    );
    return undefined;
  }
}

/**
 * production/preview向けの厳格版。以下をすべて必須とする:
 * APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY / APPLE_TOKEN_ENCRYPTION_KEY /
 * APPLE_TOKEN_ENCRYPTION_KEY_VERSION / APPLE_CLIENT_ID（呼び出し側で既に検証済みのため引数で受け取る）。
 * `resolveAppleTokenExchangeConfig`と異なり、1つでも欠けていれば`undefined`を返さず
 * `AuthConfigError`を投げる（呼び出し側で`POST /auth/apple`を503 AUTH_NOT_CONFIGUREDにする）。
 * `APPLE_TOKEN_ENCRYPTION_KEY_VERSION`は`resolveAppleTokenExchangeConfig`ではデフォルト値
 * ('v1')にフォールバックするが、ここでは明示設定を必須とする。
 */
export function requireAppleTokenExchangeConfig(env: Env, appleClientId: string): AppleTokenExchangeRuntimeConfig {
  if (!env.APPLE_TOKEN_ENCRYPTION_KEY_VERSION || env.APPLE_TOKEN_ENCRYPTION_KEY_VERSION.trim().length === 0) {
    throw new AuthConfigError("APPLE_TOKEN_ENCRYPTION_KEY_VERSION が未設定です（本番/プレビューでは必須）");
  }
  const config = resolveAppleTokenExchangeConfig(env, appleClientId);
  if (!config) {
    throw new AuthConfigError(
      "Apple token交換の設定が不足しています（APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY / APPLE_TOKEN_ENCRYPTION_KEY のいずれかが未設定または不正です。本番/プレビューでは必須）"
    );
  }
  return config;
}
