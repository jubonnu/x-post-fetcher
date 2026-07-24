/**
 * 共通型定義（Node/Workers 両方で使用）。
 * Phase 1 では source_posts の生データ受け渡しに必要な型のみ。
 * （Phase 2 以降で PostType/CardType/Precision/Status などを追加予定）
 */

export type Platform = "x";

/** 取込結果のアクション種別 */
export type IngestAction = "inserted" | "updated" | "unchanged";
