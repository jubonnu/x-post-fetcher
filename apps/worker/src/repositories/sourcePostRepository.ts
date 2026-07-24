import { eq } from "drizzle-orm";
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
