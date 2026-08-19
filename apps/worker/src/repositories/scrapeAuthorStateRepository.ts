import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { scrapeAuthorStates } from "../db/schema.ts";

/**
 * 対象アカウントの直近実行状態を取得する。行が無い場合（初回実行前）は
 * `needsRecovery: false`として扱う（＝通常の高速差分取得から開始する）。
 */
export async function getScrapeAuthorState(db: Db, authorUsername: string): Promise<{ needsRecovery: boolean }> {
  const rows = await db
    .select({ needsRecovery: scrapeAuthorStates.needsRecovery })
    .from(scrapeAuthorStates)
    .where(eq(scrapeAuthorStates.authorUsername, authorUsername))
    .limit(1);
  return { needsRecovery: rows[0]?.needsRecovery ?? false };
}

/**
 * 今回の差分取得の走査結果（既知境界まで安全に到達できたか）を記録する。
 * `needsRecovery: true`（走査未完了）を保存する呼び出しは、scraper側でingestより前に
 * 実行され、失敗した場合はingest自体が行われない（呼び出し元の責務）。
 * `false`（走査完了・自己修復）はingest成功後に呼ばれ、失敗しても安全側（recoveryモード継続）。
 */
export async function setScrapeAuthorState(db: Db, authorUsername: string, needsRecovery: boolean): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db
    .select({ authorUsername: scrapeAuthorStates.authorUsername })
    .from(scrapeAuthorStates)
    .where(eq(scrapeAuthorStates.authorUsername, authorUsername))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(scrapeAuthorStates).values({ authorUsername, needsRecovery, updatedAt: now });
    return;
  }

  await db
    .update(scrapeAuthorStates)
    .set({ needsRecovery, updatedAt: now })
    .where(eq(scrapeAuthorStates.authorUsername, authorUsername));
}
