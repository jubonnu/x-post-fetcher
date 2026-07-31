import type { Env } from "../env.ts";

/**
 * Apple側トークン失効リトライの指数バックオフ計算（Mobile-G2A-Hardening）。
 * 純粋関数のみ（DBアクセス無し）でaccountDeletionRepository/リトライジョブ両方から利用する。
 */
export const APPLE_REVOCATION_RETRY_BASE_MINUTES = 5;
export const APPLE_REVOCATION_RETRY_MAX_MINUTES = 24 * 60;
export const APPLE_REVOCATION_MAX_ATTEMPTS = 5;
export const DEFAULT_APPLE_REVOCATION_PROCESSING_TIMEOUT_MINUTES = 30;

/**
 * `attemptsAfterThisFailure`（今回の失敗を含めた通算失敗回数）に応じた次回再試行時刻を返す。
 * 5分 → 10分 → 20分 → 40分 ... と倍増し、最大24時間でキャップする。
 */
export function computeNextRetryAt(attemptsAfterThisFailure: number, from: Date = new Date()): string {
  const exponent = Math.max(attemptsAfterThisFailure - 1, 0);
  const delayMinutes = Math.min(APPLE_REVOCATION_RETRY_BASE_MINUTES * 2 ** exponent, APPLE_REVOCATION_RETRY_MAX_MINUTES);
  return new Date(from.getTime() + delayMinutes * 60_000).toISOString();
}

/** `APPLE_REVOCATION_PROCESSING_TIMEOUT_MINUTES`（未設定時は既定値30分）を解決する。 */
export function resolveProcessingTimeoutMinutes(env: Env): number {
  const raw = Number(env.APPLE_REVOCATION_PROCESSING_TIMEOUT_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_APPLE_REVOCATION_PROCESSING_TIMEOUT_MINUTES;
}

/** stale判定の閾値時刻（この時刻より前にprocessingへ入った行はstale）をISO文字列で返す。 */
export function computeStaleThreshold(timeoutMinutes: number, from: Date = new Date()): string {
  return new Date(from.getTime() - timeoutMinutes * 60_000).toISOString();
}
