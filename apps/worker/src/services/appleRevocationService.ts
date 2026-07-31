import type { Db } from "../db/client.ts";
import type { Env } from "../env.ts";
import { generateAppleClientSecret, revokeAppleToken } from "../auth/appleTokenExchange.ts";
import { resolveAppleTokenExchangeConfig } from "../auth/appleTokenExchangeConfig.ts";
import { decryptToken } from "../auth/tokenEncryption.ts";
import {
  markAppleRevocationNotApplicable,
  markAppleRevocationSucceeded,
  recordAppleRevocationFailure,
} from "../repositories/accountDeletionRepository.ts";
import { claimRequestForRetry, findAppleRevocationRetryTargets } from "../repositories/appleRevocationRetryRepository.ts";
import { findAppleIdentityByUserId, findUserByInternalId } from "../repositories/userRepository.ts";
import { computeStaleThreshold, resolveProcessingTimeoutMinutes } from "./appleRevocationBackoff.ts";

export type AppleRevocationOutcome =
  | { outcome: "not_applicable" }
  | { outcome: "config_unavailable" }
  | { outcome: "succeeded" }
  | { outcome: "failed"; willRetryAt: string | null }
  /** クレームがstale判定で別Workerに奪われた後の書き込みで、フェンシングにより無視された。 */
  | { outcome: "fenced" };

/**
 * Apple側Refresh Token失効の実処理（`DELETE /me`の即時試行・Cron再試行ジョブの両方から使う）。
 * `requestId`（account_deletion_requestsの行）に対する状態更新まで行う。
 * 呼び出し側で例外は投げない（内部で捕捉し`failed`として記録する）。
 *
 * `claimId`はCron再試行経由（`retryOneAppleRevocation`）でのみ渡される。指定された場合、
 * 全ての状態更新は`WHERE claimId = 指定値`を条件に含む（フェンシング）。stale判定で
 * 別Workerに再クレームされた後に古いWorkerがここへ到達しても、実際の更新は行われない
 * （`DELETE /me`の即時試行はクレームの概念が無いため`claimId`を渡さず、常に無条件更新する）。
 */
export async function performAppleRevocationAttempt(params: {
  db: Db;
  env: Env;
  userId: number;
  requestId: number;
  claimId?: string;
}): Promise<AppleRevocationOutcome> {
  const { db, env, userId, requestId, claimId } = params;

  const user = await findUserByInternalId(db, userId);
  if (!user) {
    // ユーザーが既に物理削除済み（将来の削除バッチ実行後等）。失効対象自体が無い。
    const { fenced } = await markAppleRevocationNotApplicable(db, requestId, { claimId });
    return fenced ? { outcome: "fenced" } : { outcome: "not_applicable" };
  }

  const identity = await findAppleIdentityByUserId(db, userId);
  if (
    !identity ||
    !identity.appleRefreshTokenCiphertext ||
    !identity.appleRefreshTokenIv ||
    !identity.appleRefreshTokenKeyVersion
  ) {
    const { fenced } = await markAppleRevocationNotApplicable(db, requestId, { claimId });
    return fenced ? { outcome: "fenced" } : { outcome: "not_applicable" };
  }

  const appleClientId = env.APPLE_CLIENT_ID;
  if (!appleClientId) {
    const result = await recordAppleRevocationFailure(db, requestId, "apple_client_id_not_configured", { claimId });
    return result.fenced ? { outcome: "fenced" } : { outcome: "failed", willRetryAt: result.nextRetryAt };
  }

  const exchangeConfig = resolveAppleTokenExchangeConfig(env, appleClientId);
  if (!exchangeConfig) {
    const result = await recordAppleRevocationFailure(db, requestId, "apple_token_exchange_not_configured", { claimId });
    return result.fenced ? { outcome: "fenced" } : { outcome: "failed", willRetryAt: result.nextRetryAt };
  }

  try {
    const appleRefreshToken = await decryptToken(
      {
        ciphertextBase64: identity.appleRefreshTokenCiphertext,
        ivBase64: identity.appleRefreshTokenIv,
        keyVersion: identity.appleRefreshTokenKeyVersion,
      },
      exchangeConfig.encryptionKeys
    );

    const clientSecret = await generateAppleClientSecret(exchangeConfig.clientSecretConfig);
    await revokeAppleToken(appleRefreshToken, clientSecret, { clientId: appleClientId });
    const { fenced } = await markAppleRevocationSucceeded(db, requestId, { claimId });
    return fenced ? { outcome: "fenced" } : { outcome: "succeeded" };
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    console.error(JSON.stringify({ event: "apple_revocation_failed", requestId, message }));
    const result = await recordAppleRevocationFailure(db, requestId, message, { claimId });
    return result.fenced ? { outcome: "fenced" } : { outcome: "failed", willRetryAt: result.nextRetryAt };
  }
}

export type RetryOneOutcome = AppleRevocationOutcome | { outcome: "skipped_claimed_elsewhere" };

/**
 * Cron再試行ジョブの1件処理。まず条件付きUPDATEでクレームし（二重処理防止・stale回収の両方に
 * 対応）、クレームできた場合のみ`performAppleRevocationAttempt`をそのクレームIDと共に実行する。
 */
export async function retryOneAppleRevocation(params: {
  db: Db;
  env: Env;
  requestId: number;
}): Promise<RetryOneOutcome> {
  const { db, env, requestId } = params;
  const staleThreshold = computeStaleThreshold(resolveProcessingTimeoutMinutes(env));
  const claimed = await claimRequestForRetry(db, requestId, staleThreshold);
  if (!claimed) {
    return { outcome: "skipped_claimed_elsewhere" };
  }

  return performAppleRevocationAttempt({ db, env, userId: claimed.row.userId, requestId, claimId: claimed.claimId });
}

export interface RetryBatchResult {
  processed: number;
  succeeded: number;
  failed: number;
  notApplicable: number;
  skipped: number;
}

/** 再試行対象（staleなprocessing回収含む）を一括取得し、1件ずつ`retryOneAppleRevocation`で処理する。 */
export async function retryAppleRevocationBatch(params: {
  db: Db;
  env: Env;
  limit?: number;
}): Promise<RetryBatchResult> {
  const { db, env, limit } = params;
  const staleThreshold = computeStaleThreshold(resolveProcessingTimeoutMinutes(env));
  const targets = await findAppleRevocationRetryTargets(db, { limit, staleThreshold });

  const result: RetryBatchResult = { processed: 0, succeeded: 0, failed: 0, notApplicable: 0, skipped: 0 };

  for (const target of targets) {
    const outcome = await retryOneAppleRevocation({ db, env, requestId: target.id });
    result.processed += 1;
    if (outcome.outcome === "succeeded") result.succeeded += 1;
    else if (outcome.outcome === "failed") result.failed += 1;
    else if (outcome.outcome === "not_applicable" || outcome.outcome === "config_unavailable") result.notApplicable += 1;
    else result.skipped += 1; // skipped_claimed_elsewhere / fenced
  }

  return result;
}
