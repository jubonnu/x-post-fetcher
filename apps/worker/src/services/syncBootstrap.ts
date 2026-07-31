import type { Db, DbOrTx } from "../db/client.ts";
import { lotteryExists } from "../repositories/lotteryRepository.ts";
import {
  findDistinctProductIdsByAlias,
  findProductByPublicId,
  findProductById,
  resolveCanonicalProductId,
} from "../repositories/productRepository.ts";
import { addFavorite, findFavorite, listFavorites } from "../repositories/favoriteRepository.ts";
import { addFollow, findFollow, listFollowedProducts } from "../repositories/followedProductRepository.ts";
import { findChecklistStep, listChecklistSteps, upsertChecklistStepRow } from "../repositories/checklistRepository.ts";
import {
  findNotificationPreferences,
  upsertNotificationPreferences,
  type NotificationPreferencesFields,
} from "../repositories/notificationPreferencesRepository.ts";
import { listUserLotteries, mergeSyncLotteryItem, type SyncLotteryItem } from "../repositories/userLotteryRepository.ts";
import { serializeSnapshot, type LotterySnapshot } from "../validation/lotterySnapshot.ts";

export interface SyncBootstrapInput {
  userLotteries: Array<{
    lotteryId: number;
    status: SyncLotteryItem["status"];
    savedAt?: string;
    snapshot?: LotterySnapshot;
    clientRequestId: string;
  }>;
  favorites: Array<{ lotteryId: number; clientRequestId: string }>;
  followedProducts: Array<{ publicProductId: string; clientRequestId: string }>;
  /** Mobile-G3互換処理: `normalizedProductName`文字列のままの旧フォローデータ。 */
  legacyFollowedProductKeys: string[];
  checklistSteps: Array<{
    lotteryId: number;
    stepId: string;
    label: string;
    done: boolean;
    completedNote?: string | null;
    sortOrder?: number;
    clientRequestId: string;
  }>;
  notificationPreferences?: NotificationPreferencesFields;
}

interface CategoryResult<TConflict> {
  accepted: number;
  skipped: number;
  conflicts: TConflict[];
}

export interface SyncBootstrapMutationResult {
  userLotteries: CategoryResult<{ lotteryId: number; resolvedStatus: string; reason: string }>;
  favorites: CategoryResult<{ lotteryId: number; reason: string }>;
  followedProducts: CategoryResult<{ publicProductId: string; reason: string }>;
  /** Mobile-G3互換処理の解決結果。`unresolved`には0件/複数候補で解決できなかった元のキーを返す（内部productIdは含めない）。 */
  legacyFollowedProducts: { resolved: Array<{ legacyKey: string; publicProductId: string }>; unresolved: string[] };
  checklistSteps: CategoryResult<{ lotteryId: number; stepId: string; reason: string }>;
  notificationPreferences: { accepted: boolean; skipped: boolean; reason?: string };
}

export interface SyncBootstrapServerState {
  userLotteries: unknown[];
  favorites: unknown[];
  followedProducts: unknown[];
  checklistSteps: unknown[];
  notificationPreferences: unknown;
}

/**
 * `POST /me/sync/bootstrap`（初回ログイン時の一括同期、Mobile-G2B統合）のバッチ全体の
 * ミューテーション本体（G2B-Hardening: 呼び出し側`runIdempotent`が開いた単一トランザクション
 * `tx`の中で実行される。台帳記録とデータ更新が同一トランザクションになることを保証する）。
 *
 * すべてのカテゴリで一貫して「保守的マージ」方針を取る: サーバー側に既に有効なデータが
 * 存在する場合は上書きせず`conflicts`として報告する。新規データは無条件で採用する。
 */
export async function runSyncBootstrapMutations(tx: DbOrTx, userId: number, input: SyncBootstrapInput): Promise<SyncBootstrapMutationResult> {
  // ---- userLotteries ----
  const userLotteriesResult: CategoryResult<{ lotteryId: number; resolvedStatus: string; reason: string }> = { accepted: 0, skipped: 0, conflicts: [] };
  for (const item of input.userLotteries) {
    if (!(await lotteryExists(tx, item.lotteryId))) {
      userLotteriesResult.skipped += 1;
      continue;
    }
    let snapshotJson: string | undefined;
    if (item.snapshot !== undefined) {
      try {
        snapshotJson = serializeSnapshot(item.snapshot);
      } catch {
        userLotteriesResult.skipped += 1;
        continue;
      }
    }
    const result = await mergeSyncLotteryItem(tx, userId, { lotteryId: item.lotteryId, status: item.status, savedAt: item.savedAt, snapshotJson });
    if (result.merged) userLotteriesResult.accepted += 1;
    if (result.conflict) userLotteriesResult.conflicts.push(result.conflict);
  }

  // ---- favorites ----
  const favoritesResult: CategoryResult<{ lotteryId: number; reason: string }> = { accepted: 0, skipped: 0, conflicts: [] };
  for (const item of input.favorites) {
    if (!(await lotteryExists(tx, item.lotteryId))) {
      favoritesResult.skipped += 1;
      continue;
    }
    const existing = await findFavorite(tx, userId, item.lotteryId);
    if (existing) {
      favoritesResult.conflicts.push({ lotteryId: item.lotteryId, reason: "server_already_had_data" });
      continue;
    }
    await addFavorite(tx, { userId, lotteryId: item.lotteryId });
    favoritesResult.accepted += 1;
  }

  // ---- followedProducts ----
  const followedProductsResult: CategoryResult<{ publicProductId: string; reason: string }> = { accepted: 0, skipped: 0, conflicts: [] };
  for (const item of input.followedProducts) {
    const product = await findProductByPublicId(tx, item.publicProductId);
    if (!product) {
      followedProductsResult.skipped += 1;
      continue;
    }
    const canonicalId = await resolveCanonicalProductId(tx, product.id);
    const canonicalProduct = await findProductById(tx, canonicalId);
    if (!canonicalProduct || canonicalProduct.lifecycleStatus === "archived") {
      followedProductsResult.skipped += 1;
      continue;
    }
    const existing = await findFollow(tx, userId, canonicalId);
    if (existing) {
      followedProductsResult.conflicts.push({ publicProductId: item.publicProductId, reason: "server_already_had_data" });
      continue;
    }
    await addFollow(tx, { userId, productId: canonicalId });
    followedProductsResult.accepted += 1;
  }

  // ---- legacyFollowedProductKeys（Mobile-G3互換処理） ----
  // normalizedAlias単独（バージョン横断）で指す商品IDが1つに絞れる場合のみ移行する。
  // あいまい一致はせず、新規商品も作成しない（productResolutionのバックフィル専用ロジックとは異なる）。
  const legacyFollowedProductsResult: { resolved: Array<{ legacyKey: string; publicProductId: string }>; unresolved: string[] } = {
    resolved: [],
    unresolved: [],
  };
  for (const legacyKey of input.legacyFollowedProductKeys) {
    const candidateProductIds = await findDistinctProductIdsByAlias(tx, legacyKey);
    if (candidateProductIds.length !== 1) {
      legacyFollowedProductsResult.unresolved.push(legacyKey);
      continue;
    }
    const canonicalId = await resolveCanonicalProductId(tx, candidateProductIds[0]);
    const canonicalProduct = await findProductById(tx, canonicalId);
    if (!canonicalProduct || canonicalProduct.lifecycleStatus === "archived") {
      legacyFollowedProductsResult.unresolved.push(legacyKey);
      continue;
    }
    await addFollow(tx, { userId, productId: canonicalId });
    legacyFollowedProductsResult.resolved.push({ legacyKey, publicProductId: canonicalProduct.publicProductId });
  }

  // ---- checklistSteps ----
  const checklistResult: CategoryResult<{ lotteryId: number; stepId: string; reason: string }> = { accepted: 0, skipped: 0, conflicts: [] };
  for (const item of input.checklistSteps) {
    if (!(await lotteryExists(tx, item.lotteryId))) {
      checklistResult.skipped += 1;
      continue;
    }
    const existing = await findChecklistStep(tx, userId, item.lotteryId, item.stepId);
    if (existing) {
      checklistResult.conflicts.push({ lotteryId: item.lotteryId, stepId: item.stepId, reason: "server_already_had_data" });
      continue;
    }
    await upsertChecklistStepRow(tx, {
      userId,
      lotteryId: item.lotteryId,
      stepId: item.stepId,
      label: item.label,
      done: item.done,
      completedNote: item.completedNote,
      sortOrder: item.sortOrder,
      expectedServerVersion: 0,
    });
    checklistResult.accepted += 1;
  }

  // ---- notificationPreferences ----
  let notificationPreferencesResult: { accepted: boolean; skipped: boolean; reason?: string } = { accepted: false, skipped: true };
  if (input.notificationPreferences) {
    const existing = await findNotificationPreferences(tx, userId);
    if (existing) {
      notificationPreferencesResult = { accepted: false, skipped: true, reason: "server_already_had_data" };
    } else {
      await upsertNotificationPreferences(tx, { userId, fields: input.notificationPreferences });
      notificationPreferencesResult = { accepted: true, skipped: false };
    }
  }

  return {
    userLotteries: userLotteriesResult,
    favorites: favoritesResult,
    followedProducts: followedProductsResult,
    legacyFollowedProducts: legacyFollowedProductsResult,
    checklistSteps: checklistResult,
    notificationPreferences: notificationPreferencesResult,
  };
}

/**
 * トランザクションコミット後に現在のサーバー正規状態を読み出す（G2B-Hardening: 冪等再送
 * （台帳キャッシュヒット）の場合でも常に最新の状態を返すため、ミューテーション結果とは
 * 独立に、都度フレッシュに読み出す。キャッシュはしない）。
 */
export async function readSyncBootstrapServerState(db: Db, userId: number, touchedLotteryIds: number[]): Promise<SyncBootstrapServerState> {
  const [userLotteriesState, favoritesState, followedProductsState, notificationPreferencesState] = await Promise.all([
    listUserLotteries(db, userId, { limit: 500 }),
    listFavorites(db, userId, { limit: 500 }),
    listFollowedProducts(db, userId, { limit: 500 }),
    findNotificationPreferences(db, userId),
  ]);

  const uniqueLotteryIds = [...new Set(touchedLotteryIds)];
  const checklistStepsState = (await Promise.all(uniqueLotteryIds.map((lotteryId) => listChecklistSteps(db, userId, lotteryId)))).flat();

  return {
    userLotteries: userLotteriesState.items,
    favorites: favoritesState.items,
    followedProducts: followedProductsState.items,
    checklistSteps: checklistStepsState,
    notificationPreferences: notificationPreferencesState,
  };
}
