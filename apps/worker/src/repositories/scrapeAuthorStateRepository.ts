import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { scrapeAuthorStates } from "../db/schema.ts";

export interface ScrapeAuthorState {
  needsRecovery: boolean;
  /** recovery cursor（走査未完了時に「今回どこまで遡ったか」）。走査完了/未実行なら両方null。 */
  recoveryCursorExternalPostId: string | null;
  recoveryCursorPublishedAt: string | null;
}

/**
 * 対象アカウントの直近実行状態を取得する。行が無い場合（初回実行前）は
 * `needsRecovery: false` / cursorなしとして扱う（＝通常の高速差分取得から開始する）。
 */
export async function getScrapeAuthorState(db: Db, authorUsername: string): Promise<ScrapeAuthorState> {
  const rows = await db
    .select({
      needsRecovery: scrapeAuthorStates.needsRecovery,
      recoveryCursorExternalPostId: scrapeAuthorStates.recoveryCursorExternalPostId,
      recoveryCursorPublishedAt: scrapeAuthorStates.recoveryCursorPublishedAt,
    })
    .from(scrapeAuthorStates)
    .where(eq(scrapeAuthorStates.authorUsername, authorUsername))
    .limit(1);
  const row = rows[0];
  return {
    needsRecovery: row?.needsRecovery ?? false,
    recoveryCursorExternalPostId: row?.recoveryCursorExternalPostId ?? null,
    recoveryCursorPublishedAt: row?.recoveryCursorPublishedAt ?? null,
  };
}

export interface SetScrapeAuthorStateInput {
  needsRecovery: boolean;
  /**
   * 省略時は既存値を変更しない（呼び出し元がcursorを把握していない箇所からの呼び出しに配慮）。
   * `null`を明示的に渡すとcursorを解除する（走査完了時）。
   */
  recoveryCursorExternalPostId?: string | null;
  recoveryCursorPublishedAt?: string | null;
}

/**
 * 今回の差分取得の走査結果（既知境界まで安全に到達できたか）と recovery cursor を記録する。
 * `needsRecovery: true`（走査未完了）を保存する呼び出しは、scraper側でingestより前に
 * 実行され、失敗した場合はingest自体が行われない（呼び出し元の責務）。
 * `false`（走査完了・自己修復）はingest成功後に呼ばれ、失敗しても安全側（recoveryモード継続）。
 */
export async function setScrapeAuthorState(db: Db, authorUsername: string, input: SetScrapeAuthorStateInput): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db
    .select({ authorUsername: scrapeAuthorStates.authorUsername })
    .from(scrapeAuthorStates)
    .where(eq(scrapeAuthorStates.authorUsername, authorUsername))
    .limit(1);

  const cursorFields = {
    ...(input.recoveryCursorExternalPostId !== undefined
      ? { recoveryCursorExternalPostId: input.recoveryCursorExternalPostId }
      : {}),
    ...(input.recoveryCursorPublishedAt !== undefined ? { recoveryCursorPublishedAt: input.recoveryCursorPublishedAt } : {}),
  };

  if (existing.length === 0) {
    await db.insert(scrapeAuthorStates).values({
      authorUsername,
      needsRecovery: input.needsRecovery,
      recoveryCursorExternalPostId: input.recoveryCursorExternalPostId ?? null,
      recoveryCursorPublishedAt: input.recoveryCursorPublishedAt ?? null,
      updatedAt: now,
    });
    return;
  }

  await db
    .update(scrapeAuthorStates)
    .set({ needsRecovery: input.needsRecovery, ...cursorFields, updatedAt: now })
    .where(eq(scrapeAuthorStates.authorUsername, authorUsername));
}

export interface ClaudeCheckpoint {
  authorUsername: string;
  /** 最後にXで確認した投稿のID。「最後にDBへ保存した投稿」とは別概念（未保存の投稿でも設定できる）。 */
  externalPostId: string | null;
  publishedAt: string | null;
  /** チェックポイントを更新した日時（サーバー側で設定）。 */
  checkedAt: string | null;
}

/**
 * 管理画面「Claude投入」用のチェックポイントを取得する。行が無い場合（未設定）は
 * 全フィールドnullとして返す。
 */
export async function getClaudeCheckpoint(db: Db, authorUsername: string): Promise<ClaudeCheckpoint> {
  const rows = await db
    .select({
      externalPostId: scrapeAuthorStates.claudeCheckedExternalPostId,
      publishedAt: scrapeAuthorStates.claudeCheckedPublishedAt,
      checkedAt: scrapeAuthorStates.claudeCheckedAt,
    })
    .from(scrapeAuthorStates)
    .where(eq(scrapeAuthorStates.authorUsername, authorUsername))
    .limit(1);
  const row = rows[0];
  return {
    authorUsername,
    externalPostId: row?.externalPostId ?? null,
    publishedAt: row?.publishedAt ?? null,
    checkedAt: row?.checkedAt ?? null,
  };
}

export interface SetClaudeCheckpointInput {
  externalPostId: string;
  publishedAt: string;
}

/**
 * チェックポイントを更新する（管理画面からの手動操作専用。scraperの自動実行からは呼ばない）。
 * `checkedAt`はこの呼び出し時刻をサーバー側で設定する。既存行が無ければ新規作成する
 * （`needsRecovery`はscraper側のデフォルトであるfalseで作成し、scraper自身の状態には触れない）。
 */
export async function setClaudeCheckpoint(db: Db, authorUsername: string, input: SetClaudeCheckpointInput): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db
    .select({ authorUsername: scrapeAuthorStates.authorUsername })
    .from(scrapeAuthorStates)
    .where(eq(scrapeAuthorStates.authorUsername, authorUsername))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(scrapeAuthorStates).values({
      authorUsername,
      needsRecovery: false,
      claudeCheckedExternalPostId: input.externalPostId,
      claudeCheckedPublishedAt: input.publishedAt,
      claudeCheckedAt: now,
      updatedAt: now,
    });
    return;
  }

  await db
    .update(scrapeAuthorStates)
    .set({
      claudeCheckedExternalPostId: input.externalPostId,
      claudeCheckedPublishedAt: input.publishedAt,
      claudeCheckedAt: now,
    })
    .where(eq(scrapeAuthorStates.authorUsername, authorUsername));
}
