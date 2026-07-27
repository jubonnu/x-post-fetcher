import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export type JobType = "resolve_urls" | "analyze_post";
export type JobStatus = "pending" | "running" | "done" | "failed";

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

/**
 * post_analyses — ルールベース解析結果（Phase 2）。LLM は使用しない。
 * 再解析条件は inputContentHash（= source_posts.content_hash）のみで判定する。
 */
export const postAnalyses = sqliteTable("post_analyses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourcePostId: integer("source_post_id").notNull(),
  postType: text("post_type"),
  isLotteryInformation: integer("is_lottery_information", { mode: "boolean" }),
  cardType: text("card_type"),
  confidenceScore: text("confidence_score"),
  analysisStatus: text("analysis_status"),
  parserVersion: text("parser_version"), // ルールパーサ版（記録用）
  inputContentHash: text("input_content_hash"),
  extractedData: text("extracted_data"), // JSON（抽出結果 + urls）
  analyzedAt: text("analyzed_at"),
  errorMessage: text("error_message"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export type PostAnalysisRow = typeof postAnalyses.$inferSelect;

/**
 * lotteries — ユーザーに表示する抽選本体（Phase 2 は単純 insert、同一判定は Phase 3）。
 * 正規化前 Raw 値を必ず保持。日時は at / date / precision を分離保持。
 */
export const lotteries = sqliteTable("lotteries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourcePostId: integer("source_post_id"),
  productNameRaw: text("product_name_raw"),
  normalizedProductName: text("normalized_product_name"),
  cardType: text("card_type"),
  storeNameRaw: text("store_name_raw"),
  normalizedStoreName: text("normalized_store_name"),
  storeBranchRaw: text("store_branch_raw"),
  normalizedStoreBranch: text("normalized_store_branch"),
  region: text("region"),
  normalizerVersion: text("normalizer_version"),
  applicationStartAt: text("application_start_at"),
  confirmedOpenAt: text("confirmed_open_at"),
  applicationEndAt: text("application_end_at"),
  applicationEndDate: text("application_end_date"),
  applicationEndPrecision: text("application_end_precision"),
  resultAnnouncementAt: text("result_announcement_at"),
  resultAnnouncementDate: text("result_announcement_date"),
  resultAnnouncementPrecision: text("result_announcement_precision"),
  purchaseStartAt: text("purchase_start_at"),
  purchaseDeadlineAt: text("purchase_deadline_at"),
  applicationUrl: text("application_url"),
  resolvedApplicationUrl: text("resolved_application_url"),
  applicationUrlHttpStatus: integer("application_url_http_status"),
  urlResolvedAt: text("url_resolved_at"),
  officialInformationUrl: text("official_information_url"),
  appDownloadUrl: text("app_download_url"),
  applicationMethod: text("application_method"),
  eligibilityConditions: text("eligibility_conditions"),
  pickupMethod: text("pickup_method"),
  paymentMethod: text("payment_method"),
  price: text("price"),
  status: text("status"),
  completenessScore: text("completeness_score"),
  verificationStatus: text("verification_status"),
  // Phase 5: 承認/却下
  approvedBy: text("approved_by"),
  approvedAt: text("approved_at"),
  rejectedReason: text("rejected_reason"),
  rejectedAt: text("rejected_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export type LotteryRow = typeof lotteries.$inferSelect;
export type LotteryInsert = typeof lotteries.$inferInsert;

/**
 * lottery_sources — 1つの抽選に寄与した情報源（source_posts）を記録（Phase 3）。
 * 同一抽選マッチングで複数投稿が同じ抽選に統合された場合、どの投稿が寄与したかを保持する。
 */
export const lotterySources = sqliteTable("lottery_sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lotteryId: integer("lottery_id").notNull(),
  sourcePostId: integer("source_post_id").notNull(),
  matchAction: text("match_action"), // new / merge / review
  matchScore: text("match_score"),
  matchReason: text("match_reason"),
  contributedFields: text("contributed_fields"), // JSON: 反映したフィールド名の配列
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export type LotterySourceRow = typeof lotterySources.$inferSelect;

/**
 * lottery_field_history — 抽選フィールドの変更履歴（Phase 3）。
 * created（新規）/ updated（空欄補完・上書き）/ conflicting（競合で不採用）を記録する。
 */
export const lotteryFieldHistory = sqliteTable("lottery_field_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lotteryId: integer("lottery_id").notNull(),
  sourcePostId: integer("source_post_id"),
  fieldName: text("field_name").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changeType: text("change_type").notNull(), // created / updated / conflicting
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export type LotteryFieldHistoryRow = typeof lotteryFieldHistory.$inferSelect;

/**
 * processing_jobs — 非同期・リトライ可能なジョブ管理（Phase 4）。
 * jobType: 'resolve_urls'（URL 解決）| 'analyze_post'（再解析）
 * status: pending → running → done / failed（失敗時は attempts < maxAttempts なら pending に戻す）
 */
export const processingJobs = sqliteTable("processing_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobType: text("job_type").notNull(),
  status: text("status").notNull().default("pending"),
  sourcePostId: integer("source_post_id"),
  lotteryId: integer("lottery_id"),
  payload: text("payload"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  nextRetryAt: text("next_retry_at"),
  lastError: text("last_error"),
  lockedAt: text("locked_at"),
  lockedBy: text("locked_by"),
  completedAt: text("completed_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export type ProcessingJobRow = typeof processingJobs.$inferSelect;
