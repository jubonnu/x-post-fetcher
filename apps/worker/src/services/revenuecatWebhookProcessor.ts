import type { DbOrTx } from "../db/client.ts";
import { findUserByPublicUserId } from "../repositories/userRepository.ts";
import {
  RevenuecatEventAlreadyExistsError,
  insertRevenuecatEvent,
  markRevenuecatEventError,
  markRevenuecatEventProcessed,
  markRevenuecatEventStatus,
} from "../repositories/revenuecatEventRepository.ts";
import { findSubscriptionEntitlement, upsertSubscriptionEntitlement } from "../repositories/subscriptionEntitlementRepository.ts";
import { fetchRevenueCatEntitlement, type RevenueCatApiResult } from "./revenuecatClient.ts";
import { UUID_REGEX } from "../validation/limits.ts";
import { revenueCatTransferEventSchema, type RevenueCatWebhookEvent } from "../validation/billingSchemas.ts";
import type { UserRow } from "../db/schema.ts";

/** RevenueCat Dashboardで設定するentitlement識別子（Mobile-G4、10章）。 */
export const PREMIUM_ENTITLEMENT_ID = "premium";

/**
 * 現在このWorkerが監査記録の対象とするRevenueCat Webhookイベント種別（TRANSFERは別処理）。
 * この集合に無い種別は`ignored_unknown_event`として200受領・監査のみ行い、premium状態は
 * 一切変更しない（安全側に倒れる設計。未確認の新種別が来ても誤ってpremiumを操作しない）。
 */
const KNOWN_EVENT_TYPES = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "NON_RENEWING_PURCHASE",
  "UNCANCELLATION",
  "PRODUCT_CHANGE",
  "EXPIRATION",
  "REFUND",
  "CANCELLATION",
  "BILLING_ISSUE",
]);

function extractEntitlementIds(event: RevenueCatWebhookEvent): string[] {
  return [...(event.entitlement_ids ?? []), ...(event.entitlement_id ? [event.entitlement_id] : [])];
}

export interface RevenueCatProcessingConfig {
  /** RevenueCat REST API呼び出し用Secret API Key。未設定ならREST照合ができず`failed_retryable`。 */
  secretApiKey: string | undefined;
  /** 設定済みProduct ID→productTypeの明示マップ用（Product ID最終値が未確定の間は両方未設定でよい）。 */
  monthlyProductId: string | undefined;
  lifetimeProductId: string | undefined;
}

/**
 * 設定されたProduct IDからproductTypeへの明示マップ（Mobile-G4 Hardening）。文字列の部分一致
 * による推測（旧実装の`includes('monthly')`等）は廃止した。マップ未設定・不一致の場合、有効な
 * entitlementがあっても'unknown'を返す（誤推測しない）。premiumActiveの判定自体はこの値を
 * 使わず、常にRevenueCat REST APIのentitlement有無で行う。
 */
export function deriveProductType(
  productId: string | null | undefined,
  config: Pick<RevenueCatProcessingConfig, "monthlyProductId" | "lifetimeProductId">
): string | null {
  if (!productId) return null;
  if (config.monthlyProductId && productId === config.monthlyProductId) return "subscription";
  if (config.lifetimeProductId && productId === config.lifetimeProductId) return "lifetime";
  return "unknown";
}

/**
 * app_user_id → original_app_user_id → aliases の順にpublicUserId形式の値を探し、
 * 一致するCardHubユーザーを解決する。未知のユーザーは絶対に新規作成しない。一致した
 * 候補文字列自体をRevenueCat REST APIへの照会キー（App User ID）として使う。
 */
async function resolveCandidateAppUserId(
  db: DbOrTx,
  event: RevenueCatWebhookEvent
): Promise<{ user: UserRow; appUserId: string } | null> {
  const candidates = [event.app_user_id, event.original_app_user_id, ...(event.aliases ?? [])].filter(
    (v): v is string => !!v && UUID_REGEX.test(v)
  );
  for (const candidate of candidates) {
    const user = await findUserByPublicUserId(db, candidate);
    if (user) return { user, appUserId: candidate };
  }
  return null;
}

type UserVerificationOutcome = "applied" | "superseded" | "unknown_user" | "api_failure";

/**
 * 解決済みユーザー1件分の「REST APIで現在状態を取得し、より新しければ反映する」処理。
 * Webhookイベントのtype（grant/revoke等）を直接信用せず、常にRevenueCatの現在状態を
 * 正として書き込む——イベントの到着順序が入れ替わっても最終的にRevenueCatの実状態と
 * 一致する（Mobile-G4 Hardening「イベント順序逆転対策」）。
 */
async function verifyAndApplyForResolvedUser(
  db: DbOrTx,
  publicUserId: string,
  eventTimestamp: string,
  environment: string,
  config: RevenueCatProcessingConfig,
  source: string
): Promise<UserVerificationOutcome> {
  const user = await findUserByPublicUserId(db, publicUserId);
  if (!user) return "unknown_user";
  if (!config.secretApiKey) return "api_failure"; // REST照合ができない=イベント推測だけで状態変更しない

  const result = await fetchRevenueCatEntitlement(config.secretApiKey, publicUserId);
  if (result.type !== "success") return "api_failure";

  return applyVerifiedEntitlement(db, user.id, result, eventTimestamp, environment, config, source);
}

/**
 * Webhookイベントの`event_timestamp_ms`（数値・エポックミリ秒）から、順序逆転ガードの
 * 比較キーとして使う文字列を生成する。
 *
 * 【固定された前提・変更禁止】この関数は必ず`Date.prototype.toISOString()`が返す
 * UTC固定形式（`YYYY-MM-DDTHH:mm:ss.sssZ`——常にUTC、常に4桁年・2桁月日時分秒、常に
 * 3桁ミリ秒、常に`Z`終端）の文字列のみを返す。この形式が保たれる限り、辞書式文字列比較
 * （`>`）は数値としての時系列比較と完全に一致する。下の`applyVerifiedEntitlement`の
 * 順序逆転ガード（`existing.lastRevenueCatEventAt > eventTimestamp`）はこの前提に
 * 全面的に依存しているため、この関数の出力形式を変更する場合（ローカルタイムゾーン化、
 * 桁数が可変な独自フォーマット化等）は順序逆転ガードごと見直すこと。
 * 形式は`tests/revenuecatEventTimestamp.test.ts`で固定している。
 *
 * 【残課題】現状は文字列比較のみで運用しており、フォーマットの前提が崩れると静かに
 * 誤動作しうる。将来的には`event_timestamp_ms`という数値そのものを`revenuecat_events`・
 * `subscription_entitlements`へ保持し、数値比較へ移行する方がフォーマット依存を無くせて
 * 本質的に安全（スキーマ変更を伴うため今回は見送り。G4-5以降の改善候補として記録）。
 */
export function toEventTimestamp(eventTimestampMs: number | null | undefined): string {
  return eventTimestampMs != null ? new Date(eventTimestampMs).toISOString() : new Date().toISOString();
}

/**
 * REST照合結果をDBへ反映する。反映直前に、既に記録済みの`lastRevenueCatEventAt`が今回の
 * `eventTimestamp`より新しければ書き込みをスキップする（＝古い・遅延到着のWebhookが新しい
 * 状態を上書きしない）。これにより RENEWAL→EXPIRATION の到着順が入れ替わっても、最終的な
 * DB状態は常に時系列上最も新しいイベントが反映した値のまま保たれる（`toEventTimestamp`の
 * UTC固定形式の前提の上に成り立つ、上記コメント参照）。
 */
async function applyVerifiedEntitlement(
  db: DbOrTx,
  userId: number,
  verification: Extract<RevenueCatApiResult, { type: "success" }>,
  eventTimestamp: string,
  environment: string,
  config: RevenueCatProcessingConfig,
  source: string
): Promise<"applied" | "superseded"> {
  const existing = await findSubscriptionEntitlement(db, userId);
  if (existing?.lastRevenueCatEventAt && existing.lastRevenueCatEventAt > eventTimestamp) {
    return "superseded";
  }

  const entitlement = verification.entitlement;
  const productId = entitlement?.product_identifier ?? existing?.productId ?? null;
  await upsertSubscriptionEntitlement(db, userId, {
    entitlementId: PREMIUM_ENTITLEMENT_ID,
    premiumActive: verification.premiumActive,
    productId,
    productType: deriveProductType(productId, config),
    environment,
    store: entitlement?.store ?? existing?.store ?? null,
    originalTransactionId: existing?.originalTransactionId ?? null,
    purchasedAt: entitlement?.purchase_date ?? existing?.purchasedAt ?? null,
    expiresAt: entitlement ? (entitlement.expires_date ?? null) : null,
    ownershipType: existing?.ownershipType ?? null,
    lastRevenueCatEventAt: eventTimestamp,
    source,
  });
  return "applied";
}

export type WebhookProcessingResult =
  | "processed"
  | "superseded"
  | "duplicate"
  | "conflict"
  | "failed_retryable"
  | "ignored_unknown_user"
  | "ignored_not_premium"
  | "ignored_unknown_event"
  | "ignored_invalid_payload";

/**
 * TRANSFER以外の通常イベントの処理フロー（Mobile-G4 Hardening）:
 * 1. 既知の種別か確認（未知なら監査のみ）
 * 2. premium entitlementに関係するイベントか確認
 * 3. app_user_id/original_app_user_id/aliasesからCardHubユーザーを解決
 * 4. RevenueCat REST APIで現在のsubscriber状態を取得
 * 5. premium entitlementの現在状態を判定
 * 6. subscription_entitlementsへ反映（順序逆転ガード付き）
 * 7. eventをprocessedへ更新
 */
async function processNormalEvent(
  db: DbOrTx,
  event: RevenueCatWebhookEvent,
  eventTimestamp: string,
  environment: string,
  eventRowId: number,
  config: RevenueCatProcessingConfig
): Promise<WebhookProcessingResult> {
  if (!KNOWN_EVENT_TYPES.has(event.type)) {
    await markRevenuecatEventProcessed(db, eventRowId, "ignored_unknown_event");
    return "ignored_unknown_event";
  }

  if (!extractEntitlementIds(event).includes(PREMIUM_ENTITLEMENT_ID)) {
    await markRevenuecatEventProcessed(db, eventRowId, "ignored_not_premium");
    return "ignored_not_premium";
  }

  const resolved = await resolveCandidateAppUserId(db, event);
  if (!resolved) {
    await markRevenuecatEventProcessed(db, eventRowId, "ignored_unknown_user");
    return "ignored_unknown_user";
  }

  if (!config.secretApiKey) {
    await markRevenuecatEventStatus(db, eventRowId, "failed_retryable", "revenuecat_api_key_unconfigured");
    return "failed_retryable";
  }

  const result = await fetchRevenueCatEntitlement(config.secretApiKey, resolved.appUserId);
  if (result.type !== "success") {
    await markRevenuecatEventStatus(db, eventRowId, "failed_retryable", `revenuecat_api_${result.type}`);
    return "failed_retryable";
  }

  const outcome = await applyVerifiedEntitlement(db, resolved.user.id, result, eventTimestamp, environment, config, "webhook");
  if (outcome === "superseded") {
    await markRevenuecatEventStatus(db, eventRowId, "superseded");
    return "superseded";
  }

  await markRevenuecatEventProcessed(db, eventRowId, "processed");
  return "processed";
}

/**
 * TRANSFERイベント専用処理（Mobile-G4 Hardening、通常イベントとは別スキーマ・別フロー）。
 * `transferred_from`・`transferred_to`はそれぞれ複数件になり得るため、両配列を結合した
 * 一意なApp User ID群それぞれについて個別にREST照合・反映を行う（移譲元・移譲先どちらが
 * premiumを持つべきかをコード側で仮定せず、RevenueCatの現在状態をそのまま反映する）。
 * 一方が未知ユーザーでも既知の側だけは処理する。既知ユーザーのいずれかでREST照合が
 * 一時失敗した場合はイベント全体を`failed_retryable`として記録する（成功した側の反映は
 * 保持しつつ、未確定の側があることを示す）。
 */
async function processTransferEvent(
  db: DbOrTx,
  event: RevenueCatWebhookEvent,
  eventTimestamp: string,
  environment: string,
  eventRowId: number,
  config: RevenueCatProcessingConfig
): Promise<WebhookProcessingResult> {
  const parsed = revenueCatTransferEventSchema.safeParse(event);
  if (!parsed.success) {
    await markRevenuecatEventStatus(db, eventRowId, "ignored_invalid_payload", "invalid_transfer_payload");
    return "ignored_invalid_payload";
  }

  if (!extractEntitlementIds(event).includes(PREMIUM_ENTITLEMENT_ID)) {
    await markRevenuecatEventProcessed(db, eventRowId, "ignored_not_premium");
    return "ignored_not_premium";
  }

  const candidateIds = [...parsed.data.transferred_from, ...parsed.data.transferred_to].filter((v) => UUID_REGEX.test(v));
  const uniqueIds = [...new Set(candidateIds)];

  if (uniqueIds.length === 0) {
    await markRevenuecatEventProcessed(db, eventRowId, "ignored_unknown_user");
    return "ignored_unknown_user";
  }

  let anyApplied = false;
  let anyKnown = false;
  let anyFailure = false;

  for (const publicUserId of uniqueIds) {
    const outcome = await verifyAndApplyForResolvedUser(db, publicUserId, eventTimestamp, environment, config, "webhook_transfer");
    if (outcome === "unknown_user") continue;
    anyKnown = true;
    if (outcome === "applied") anyApplied = true;
    if (outcome === "api_failure") anyFailure = true;
  }

  if (!anyKnown) {
    await markRevenuecatEventProcessed(db, eventRowId, "ignored_unknown_user");
    return "ignored_unknown_user";
  }

  if (anyFailure) {
    await markRevenuecatEventStatus(db, eventRowId, "failed_retryable", "revenuecat_api_failure_partial_transfer");
    return "failed_retryable";
  }

  const finalStatus = anyApplied ? "processed" : "superseded";
  await markRevenuecatEventProcessed(db, eventRowId, finalStatus);
  return finalStatus;
}

/**
 * RevenueCat Webhookイベント1件の処理（Mobile-G4、12章 + Hardening改訂）。常に例外を投げず
 * 結果を返す——ルート側はこの結果に関わらず200を返す（未知ユーザー・未対応イベント・
 * 一時的なREST照合失敗はRevenueCat側の再送ループを防ぐため200で受領し、監査記録のみ行う。
 * `failed_retryable`は「premium状態は変更していないが、後から再照合が必要」を示す監査上の
 * 印であり、この関数自体は失敗を例外として伝播しない）。
 */
export async function processRevenueCatWebhookEvent(
  db: DbOrTx,
  event: RevenueCatWebhookEvent,
  payloadHash: string,
  config: RevenueCatProcessingConfig
): Promise<WebhookProcessingResult> {
  const eventTimestamp = toEventTimestamp(event.event_timestamp_ms);
  const environment = event.environment ?? "UNKNOWN";

  let inserted;
  try {
    inserted = await insertRevenuecatEvent(db, {
      revenueCatEventId: event.id,
      eventType: event.type,
      appUserId: event.app_user_id,
      originalAppUserId: event.original_app_user_id ?? null,
      aliasesJson: event.aliases ? JSON.stringify(event.aliases) : null,
      environment,
      eventTimestamp,
      payloadHash,
    });
  } catch (e) {
    if (e instanceof RevenuecatEventAlreadyExistsError) {
      if (e.existing.payloadHash === payloadHash) return "duplicate";
      // 同じevent.idで内容が異なる再送: 上書きせず要調査として記録し、200のみ返す。
      await markRevenuecatEventError(db, e.existing.id, "payload_hash_mismatch");
      return "conflict";
    }
    throw e;
  }

  if (event.type === "TRANSFER") {
    return processTransferEvent(db, event, eventTimestamp, environment, inserted.id, config);
  }

  return processNormalEvent(db, event, eventTimestamp, environment, inserted.id, config);
}
