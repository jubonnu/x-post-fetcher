import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * source_posts — X から取得した元投稿（情報源）。
 * Phase 1 の対象テーブル。externalPostId に UNIQUE 制約。
 * 配列（imageUrls / externalUrls）は JSON 文字列で保持する。
 */
export const sourcePosts = sqliteTable(
  "source_posts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    platform: text("platform").notNull().default("x"),
    externalPostId: text("external_post_id").notNull(),
    authorId: text("author_id"),
    authorUsername: text("author_username"),
    authorDisplayName: text("author_display_name"),
    bodyRaw: text("body_raw"),
    publishedAt: text("published_at"),
    sourceUrl: text("source_url"),
    imageUrls: text("image_urls"), // JSON string
    externalUrls: text("external_urls"), // JSON string
    rawHtml: text("raw_html"),
    cleanedHtml: text("cleaned_html"),
    contentHash: text("content_hash"),
    fetchedAt: text("fetched_at"),
    deletedAt: text("deleted_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    externalPostIdUnique: uniqueIndex("source_posts_external_post_id_unique").on(t.externalPostId),
  })
);

export type SourcePostRow = typeof sourcePosts.$inferSelect;
export type SourcePostInsert = typeof sourcePosts.$inferInsert;
