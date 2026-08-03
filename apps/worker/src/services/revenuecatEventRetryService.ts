import type { Db } from "../db/client.ts";
import { findFailedRetryableRevenuecatEvents, markRevenuecatEventStatus } from "../repositories/revenuecatEventRepository.ts";
import { UUID_REGEX } from "../validation/limits.ts";
import {
  processTransferSides,
  resolveCandidateAppUserId,
  verifyAndApplyForResolvedUser,
  type RevenueCatProcessingConfig,
} from "./revenuecatWebhookProcessor.ts";

/**
 * `failed_retryable`イベントの自動再処理（Mobile-G4 Hardening、課金公開前Blocker）。
 *
 * Webhook受信時にRevenueCat REST APIが一時的に失敗した場合（Secret API Key未設定・
 * timeout・5xx等）、イベントは`revenuecat_events.processingStatus = 'failed_retryable'`
 * のまま放置され、premium状態は更新されない。これをCron Trigger・内部APIから定期的に
 * 拾い直し、再度REST照合を試みる。
 *
 * `revenuecat_events`はrawPayload全体を保持しない設計（22章）だが、通常イベント
 * （app_user_id / original_app_user_id / aliases）・TRANSFERイベント
 * （transferred_from / transferred_to）とも、再試行に必要な最小限のフィールドは列として
 * 保存されているため、いずれも保存済みの列だけで再試行できる（追加Hardening）。
 * TRANSFERコンテキストが保存されていない古い行（この対応より前に`failed_retryable`に
 * なったもの）は再試行できないため`skippedTransferNoContext`としてカウントし、
 * 手動対応が必要なことをログで可視化する。
 */

export interface RevenuecatEventRetryBatchResult {
  scanned: number;
  succeeded: number;
  stillFailed: number;
  resolvedUnknownUser: number;
  skippedTransferNoContext: number;
}

const DEFAULT_RETRY_BATCH_LIMIT = 50;

export async function retryFailedRevenuecatEventsBatch(params: {
  db: Db;
  config: RevenueCatProcessingConfig;
  limit?: number;
}): Promise<RevenuecatEventRetryBatchResult> {
  const { db, config, limit = DEFAULT_RETRY_BATCH_LIMIT } = params;
  const rows = await findFailedRetryableRevenuecatEvents(db, limit);

  const result: RevenuecatEventRetryBatchResult = {
    scanned: rows.length,
    succeeded: 0,
    stillFailed: 0,
    resolvedUnknownUser: 0,
    skippedTransferNoContext: 0,
  };

  for (const row of rows) {
    if (row.eventType === "TRANSFER") {
      await retryTransferRow(db, row, config, result);
      continue;
    }

    const aliases = row.aliasesJson ? (JSON.parse(row.aliasesJson) as string[]) : [];
    const resolved = await resolveCandidateAppUserId(db, {
      appUserId: row.appUserId,
      originalAppUserId: row.originalAppUserId,
      aliases,
    });

    if (!resolved) {
      // 再試行しても解決しない未知ユーザーは終了扱いにし、無限に再試行対象へ残さない。
      await markRevenuecatEventStatus(db, row.id, "ignored_unknown_user");
      result.resolvedUnknownUser += 1;
      continue;
    }

    const outcome = await verifyAndApplyForResolvedUser(
      db,
      resolved.appUserId,
      row.eventTimestamp,
      row.environment,
      config,
      "webhook_retry"
    );
    if (outcome === "applied" || outcome === "superseded") {
      await markRevenuecatEventStatus(db, row.id, outcome === "superseded" ? "superseded" : "processed");
      result.succeeded += 1;
    } else {
      result.stillFailed += 1;
    }
  }

  return result;
}

/**
 * TRANSFERイベント1件分の再試行。保存済みの`transferredFromJson`/`transferredToJson`から
 * 移譲元・移譲先の両方を再構築し、Webhook受信経路と同じ`processTransferSides`で
 * 双方をREST再照合する（移行元のみ・移行先のみが未知ユーザーのケースも自然にハンドルされる）。
 */
async function retryTransferRow(
  db: Db,
  row: { id: number; transferredFromJson: string | null; transferredToJson: string | null; eventTimestamp: string; environment: string },
  config: RevenueCatProcessingConfig,
  result: RevenuecatEventRetryBatchResult
): Promise<void> {
  if (!row.transferredFromJson || !row.transferredToJson) {
    result.skippedTransferNoContext += 1;
    return;
  }

  const transferredFrom = JSON.parse(row.transferredFromJson) as string[];
  const transferredTo = JSON.parse(row.transferredToJson) as string[];
  const uniqueIds = [...new Set([...transferredFrom, ...transferredTo].filter((v) => UUID_REGEX.test(v)))];

  if (uniqueIds.length === 0) {
    await markRevenuecatEventStatus(db, row.id, "ignored_unknown_user");
    result.resolvedUnknownUser += 1;
    return;
  }

  const { anyApplied, anyKnown, anyFailure } = await processTransferSides(
    db,
    uniqueIds,
    row.eventTimestamp,
    row.environment,
    config,
    "webhook_transfer_retry"
  );

  if (!anyKnown) {
    await markRevenuecatEventStatus(db, row.id, "ignored_unknown_user");
    result.resolvedUnknownUser += 1;
    return;
  }

  if (anyFailure) {
    result.stillFailed += 1; // failed_retryableのまま（ステータス変更不要、次回バッチで再試行）
    return;
  }

  await markRevenuecatEventStatus(db, row.id, anyApplied ? "processed" : "superseded");
  result.succeeded += 1;
}
