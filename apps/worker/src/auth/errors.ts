import type { Context } from "hono";

/**
 * 認証・アカウント系API共通のエラー形式。
 * {"error": {"code": "...", "message": "...", "requestId": "..."}}
 * 既存の `/lotteries` 等 `{ok:false, error}` 形式とは別系統（新設APIにのみ適用、既存APIは無変更）。
 */
export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "TOKEN_EXPIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "RATE_LIMITED"
  | "CONFIG_ERROR"
  | "AUTH_NOT_CONFIGURED"
  | "AUTH_PROVIDER_UNAVAILABLE"
  | "SERVICE_BUSY"
  | "INTERNAL_ERROR"
  | "PREMIUM_REQUIRED"
  | "BILLING_NOT_CONFIGURED";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  UNAUTHORIZED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 422,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  CONFIG_ERROR: 500,
  AUTH_NOT_CONFIGURED: 503,
  AUTH_PROVIDER_UNAVAILABLE: 503,
  SERVICE_BUSY: 503,
  INTERNAL_ERROR: 500,
  PREMIUM_REQUIRED: 403,
  BILLING_NOT_CONFIGURED: 503,
};

export class ApiError extends Error {
  code: ApiErrorCode;
  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

export function apiErrorJson(c: Context, error: ApiError) {
  const requestId = (c.get("requestId") as string | undefined) ?? "unknown";
  const status = STATUS_BY_CODE[error.code];
  return c.json(
    { error: { code: error.code, message: error.message, requestId } },
    status as 401 | 403 | 404 | 422 | 409 | 429 | 500 | 503
  );
}
