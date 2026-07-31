import type { Env } from "../env.ts";

/**
 * Mobile-G2A-Hardening: 認証設定のfail-closed検証。
 *
 * 方針転換（G2Aからの変更）:
 * - ENVIRONMENT未設定・不正値は全環境でエラー（development/test/preview/productionのみ許可）
 * - APPLE_CLIENT_ID / JWT署名鍵は、development/testであっても暗黙のプレースホルダーへ
 *   フォールバックしない（テスト鍵はテストコードから明示的にprocess.envへ注入する）
 * - productionでは上記に加えプレースホルダーらしき値（空文字・example・placeholder等）を拒否する
 * - エラーメッセージには常にフィールド名のみを含め、値そのものは含めない（ログ・レスポンス双方）
 */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

export const VALID_ENVIRONMENTS = ["development", "test", "preview", "production"] as const;
export type AppEnvironment = (typeof VALID_ENVIRONMENTS)[number];

function isValidEnvironment(value: string | undefined): value is AppEnvironment {
  return typeof value === "string" && (VALID_ENVIRONMENTS as readonly string[]).includes(value);
}

const PLACEHOLDER_SUBSTRINGS = [
  "example",
  "placeholder",
  "change-me",
  "changeme",
  "dummy",
  "sample",
  "your-",
  "your_",
  "xxxx",
  "todo",
];

function looksLikePlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  const lower = trimmed.toLowerCase();
  return PLACEHOLDER_SUBSTRINGS.some((p) => lower.includes(p));
}

function requireNonEmpty(value: string | undefined, fieldName: string): string {
  if (!value || value.trim().length === 0) {
    throw new AuthConfigError(`${fieldName} が未設定です`);
  }
  return value;
}

function requireNotPlaceholder(value: string, fieldName: string, environment: AppEnvironment): void {
  if (environment === "production" && looksLikePlaceholder(value)) {
    throw new AuthConfigError(`${fieldName} にプレースホルダーとみなされる値が設定されています（本番では使用できません）`);
  }
}

export interface JwtSigningKey {
  kid: string;
  secret: string;
}

export interface JwtSigningKeys {
  current: JwtSigningKey;
  /** ローテーション期間中のみ検証に使う直前世代の鍵（発行には使わない）。 */
  previous?: JwtSigningKey;
}

const DEFAULT_ACCOUNT_DELETION_GRACE_DAYS = 14;

function resolveAccountDeletionGraceDays(env: Env, environment: AppEnvironment): number {
  const raw = env.ACCOUNT_DELETION_GRACE_DAYS;
  if (raw === undefined || raw.trim().length === 0) {
    if (environment === "production") {
      throw new AuthConfigError("ACCOUNT_DELETION_GRACE_DAYS が未設定です（本番では必須）");
    }
    return DEFAULT_ACCOUNT_DELETION_GRACE_DAYS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AuthConfigError("ACCOUNT_DELETION_GRACE_DAYS の値が不正です（正の整数が必要）");
  }
  return parsed;
}

export interface AuthRuntimeConfig {
  environment: AppEnvironment;
  appleClientId: string;
  jwtSigningKeys: JwtSigningKeys;
  accountDeletionGraceDays: number;
}

/**
 * 認証関連の実行時設定を一括検証して返す。1つでも不正なら`AuthConfigError`を投げる
 * （呼び出し側の`requireAuthConfigured`ミドルウェアがこれを捕捉し、認証ルートのみを
 * 503 AUTH_NOT_CONFIGURED にする。`/lotteries`等の既存公開APIはこの関数を一切呼ばないため無関係）。
 */
export function resolveAuthRuntimeConfig(env: Env): AuthRuntimeConfig {
  if (!isValidEnvironment(env.ENVIRONMENT)) {
    throw new AuthConfigError(
      "ENVIRONMENTが未設定または不正な値です（development / test / preview / production のいずれかが必須）"
    );
  }
  const environment = env.ENVIRONMENT;

  const appleClientId = requireNonEmpty(env.APPLE_CLIENT_ID, "APPLE_CLIENT_ID");
  const currentKid = requireNonEmpty(env.JWT_SIGNING_KEY_CURRENT_KID, "JWT_SIGNING_KEY_CURRENT_KID");
  const currentSecret = requireNonEmpty(env.JWT_SIGNING_KEY_CURRENT_SECRET, "JWT_SIGNING_KEY_CURRENT_SECRET");

  requireNotPlaceholder(appleClientId, "APPLE_CLIENT_ID", environment);
  requireNotPlaceholder(currentKid, "JWT_SIGNING_KEY_CURRENT_KID", environment);
  requireNotPlaceholder(currentSecret, "JWT_SIGNING_KEY_CURRENT_SECRET", environment);

  let previous: JwtSigningKey | undefined;
  if (env.JWT_SIGNING_KEY_PREVIOUS_KID || env.JWT_SIGNING_KEY_PREVIOUS_SECRET) {
    const previousKid = requireNonEmpty(env.JWT_SIGNING_KEY_PREVIOUS_KID, "JWT_SIGNING_KEY_PREVIOUS_KID");
    const previousSecret = requireNonEmpty(env.JWT_SIGNING_KEY_PREVIOUS_SECRET, "JWT_SIGNING_KEY_PREVIOUS_SECRET");
    requireNotPlaceholder(previousKid, "JWT_SIGNING_KEY_PREVIOUS_KID", environment);
    requireNotPlaceholder(previousSecret, "JWT_SIGNING_KEY_PREVIOUS_SECRET", environment);
    previous = { kid: previousKid, secret: previousSecret };
  }

  const accountDeletionGraceDays = resolveAccountDeletionGraceDays(env, environment);

  return {
    environment,
    appleClientId,
    jwtSigningKeys: { current: { kid: currentKid, secret: currentSecret }, previous },
    accountDeletionGraceDays,
  };
}
