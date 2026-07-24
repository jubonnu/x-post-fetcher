/**
 * 共通型定義（Node/Workers 両方で使用）。
 */

export type Platform = "x";

/** 取込結果のアクション種別 */
export type IngestAction = "inserted" | "updated" | "unchanged";

// ---- Phase 2: 投稿分類・抽選抽出 ----

/** 投稿種別 */
export type PostType =
  | "lottery_started"
  | "lottery_summary"
  | "lottery_scheduled"
  | "lottery_updated"
  | "deadline_extended"
  | "result_announced"
  | "purchase_information"
  | "lottery_cancelled"
  | "lottery_preparation"
  | "reservation"
  | "general_sale"
  | "restock"
  | "unrelated";

export const POST_TYPES: PostType[] = [
  "lottery_started",
  "lottery_summary",
  "lottery_scheduled",
  "lottery_updated",
  "deadline_extended",
  "result_announced",
  "purchase_information",
  "lottery_cancelled",
  "lottery_preparation",
  "reservation",
  "general_sale",
  "restock",
  "unrelated",
];

/** カード種類 */
export type CardType = "pokemon" | "onepiece" | "other" | "unknown";

/** 日時の精度 */
export type DatePrecision = "datetime" | "date_only" | "store_closing_time" | "inferred" | "unknown";

/** 日時項目の状態 */
export type DateFieldStatus = "unknown" | "not_published" | "extracted" | "verified" | "conflicting";

/** 解析ステータス */
export type AnalysisStatus = "success" | "needs_review" | "failed";

/** URL 種別 */
export type UrlType =
  | "application"
  | "official_information"
  | "app_download"
  | "membership_registration"
  | "purchase"
  | "product"
  | "x_post"
  | "image"
  | "unknown";
