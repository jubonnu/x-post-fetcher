import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { SourcePostInput, IngestAction } from "@x-post/shared";
import type { Db } from "../db/client.ts";
import { sourcePosts } from "../db/schema.ts";

export interface UpsertResult {
  action: IngestAction;
  sourcePostId: number;
  externalPostId: string;
  /** 非nullなら既にアーカイブ済み（`persistAnalysis`をスキップする判定に使う）。 */
  archivedAt: string | null;
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
    return { action: "inserted", sourcePostId: inserted[0].id, externalPostId: input.externalPostId, archivedAt: null };
  }

  const row = existing[0];

  if (row.contentHash === input.contentHash) {
    // 本文変更なし: 取得日時だけ更新（再取得の鮮度を記録）、内容は据え置き
    await db
      .update(sourcePosts)
      .set({ fetchedAt: input.fetchedAt })
      .where(eq(sourcePosts.id, row.id));
    return { action: "unchanged", sourcePostId: row.id, externalPostId: input.externalPostId, archivedAt: row.archivedAt };
  }

  // 本文変更あり: 全項目更新（archivedAtは対象外＝アーカイブ状態は再取得で変化しない）
  await db
    .update(sourcePosts)
    .set({ ...values, updatedAt: now })
    .where(eq(sourcePosts.id, row.id));
  return { action: "updated", sourcePostId: row.id, externalPostId: input.externalPostId, archivedAt: row.archivedAt };
}

/**
 * source_postを アーカイブ / アンアーカイブする。物理削除は行わない。
 * アーカイブしても known IDs API からは除外されない（`findRecentExternalPostIdsByAuthor`参照）ため、
 * 差分取得の既知判定には影響しない。
 */
export async function setSourcePostArchived(
  db: Db,
  sourcePostId: number,
  archived: boolean
): Promise<{ id: number; archivedAt: string | null } | null> {
  const now = new Date().toISOString();
  const archivedAt = archived ? now : null;
  const updated = await db
    .update(sourcePosts)
    .set({ archivedAt, updatedAt: now })
    .where(eq(sourcePosts.id, sourcePostId))
    .returning({ id: sourcePosts.id, archivedAt: sourcePosts.archivedAt });
  return updated.length > 0 ? updated[0] : null;
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
 *
 * 意図的に`archivedAt`では絞り込まない: アーカイブ済み投稿もここでは「既知」として返さないと、
 * 差分取得がアーカイブ済み投稿を毎回「新規」と誤認して再取得・再ingestし続けてしまう
 * （2026-08、stagingで物理削除運用を試して実際に発生した事故の再発防止）。
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
