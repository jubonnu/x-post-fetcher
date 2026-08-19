import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { SourcePostInput, IngestAction } from "@x-post/shared";
import type { Db } from "../db/client.ts";
import { sourcePosts } from "../db/schema.ts";

export interface UpsertResult {
  action: IngestAction;
  sourcePostId: number;
  externalPostId: string;
}

/**
 * externalPostId をキーに source_posts を upsert する。
 * contentHash で本文変更を検知:
 *  - 既存なし        → inserted
 *  - 既存 & hash同一 → unchanged（fetchedAt だけ更新して鮮度を保つ）
 *  - 既存 & hash相違 → updated（全項目を更新）
 */
export async function upsertSourcePost(db: Db, input: SourcePostInput): Promise<UpsertResult> {
  const now = new Date().toISOString();

  const existing = await db
    .select()
    .from(sourcePosts)
    .where(eq(sourcePosts.externalPostId, input.externalPostId))
    .limit(1);

  const values = {
    platform: input.platform,
    externalPostId: input.externalPostId,
    authorId: input.authorId,
    authorUsername: input.authorUsername,
    authorDisplayName: input.authorDisplayName,
    bodyRaw: input.bodyRaw,
    publishedAt: input.publishedAt,
    sourceUrl: input.sourceUrl,
    imageUrls: JSON.stringify(input.imageUrls),
    externalUrls: JSON.stringify(input.externalUrls),
    rawHtml: input.rawHtml,
    cleanedHtml: input.cleanedHtml,
    contentHash: input.contentHash,
    fetchedAt: input.fetchedAt,
  };

  if (existing.length === 0) {
    const inserted = await db
      .insert(sourcePosts)
      .values({ ...values, createdAt: now, updatedAt: now })
      .returning({ id: sourcePosts.id });
    return { action: "inserted", sourcePostId: inserted[0].id, externalPostId: input.externalPostId };
  }

  const row = existing[0];

  if (row.contentHash === input.contentHash) {
    // 本文変更なし: 取得日時だけ更新（再取得の鮮度を記録）、内容は据え置き
    await db
      .update(sourcePosts)
      .set({ fetchedAt: input.fetchedAt })
      .where(eq(sourcePosts.id, row.id));
    return { action: "unchanged", sourcePostId: row.id, externalPostId: input.externalPostId };
  }

  // 本文変更あり: 全項目更新
  await db
    .update(sourcePosts)
    .set({ ...values, updatedAt: now })
    .where(eq(sourcePosts.id, row.id));
  return { action: "updated", sourcePostId: row.id, externalPostId: input.externalPostId };
}

/**
 * 指定した投稿者（大文字小文字無視）の`externalPostId`を、公開日時の新しい順に返す。
 * scraper側の差分取得（前回取得済み地点までプロフィールを遡る方式）が、DOM上で見つけた投稿を
 * 「既に取得済みか」判定するための照合用データ。1件のみ（最新ID）ではなく複数件返すのは、
 * 前回の最新投稿がX側で削除されていても、他の既知投稿との突合で安全に境界検出できるようにするため。
 *
 * `limit`省略時は全件返す。直近の差分取得が安全上限で打ち切られていた場合
 * （`scrape_author_states.lastRunHitSafetyCap`）、直近N件だけの照合では取りこぼしを見逃すため、
 * リカバリーモードとして全件と突合する必要がある（呼び出し元のルートで使い分ける）。
 */
export async function findRecentExternalPostIdsByAuthor(db: Db, authorUsername: string, limit?: number): Promise<string[]> {
  const query = db
    .select({ externalPostId: sourcePosts.externalPostId })
    .from(sourcePosts)
    .where(
      and(
        sql`lower(${sourcePosts.authorUsername}) = ${authorUsername.toLowerCase()}`,
        isNull(sourcePosts.deletedAt)
      )
    )
    .orderBy(desc(sourcePosts.publishedAt), desc(sourcePosts.id));
  const rows = limit !== undefined ? await query.limit(limit) : await query;
  return rows.map((r) => r.externalPostId);
}
