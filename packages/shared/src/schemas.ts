import { z } from "zod";

/**
 * /ingest の payload スキーマ。
 * - sourcePost: X から取得した生データ（必須）
 * - analysis:  解析結果（Phase 2）。sourcePost のみでも受信できるよう nullable/optional。
 */

export const SourcePostInputSchema = z.object({
  platform: z.literal("x").default("x"),
  externalPostId: z.string().min(1),
  authorId: z.string().nullable().default(null),
  authorUsername: z.string().nullable().default(null),
  authorDisplayName: z.string().nullable().default(null),
  bodyRaw: z.string().default(""),
  publishedAt: z.string().datetime({ offset: true }).nullable().default(null),
  sourceUrl: z.string().url(),
  imageUrls: z.array(z.string()).default([]),
  externalUrls: z.array(z.string()).default([]),
  rawHtml: z.string().default(""),
  cleanedHtml: z.string().default(""),
  contentHash: z.string().min(1),
  fetchedAt: z.string().datetime({ offset: true }),
});

export type SourcePostInput = z.infer<typeof SourcePostInputSchema>;

// ---- Phase 2 ----

export const PostTypeSchema = z.enum([
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
]);

export const CardTypeSchema = z.enum(["pokemon", "onepiece", "other", "unknown"]);
export const DatePrecisionSchema = z.enum([
  "datetime",
  "date_only",
  "store_closing_time",
  "inferred",
  "unknown",
]);
export const DateFieldStatusSchema = z.enum([
  "unknown",
  "not_published",
  "extracted",
  "verified",
  "conflicting",
]);
export const AnalysisStatusSchema = z.enum(["success", "needs_review", "failed"]);
export const UrlTypeSchema = z.enum([
  "application",
  "official_information",
  "app_download",
  "membership_registration",
  "purchase",
  "product",
  "x_post",
  "image",
  "unknown",
]);

/** 1つの日時項目（値・精度・状態・生テキストを分離保持） */
export const ResolvedDateSchema = z.object({
  at: z.string().datetime({ offset: true }).nullable().default(null),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  precision: DatePrecisionSchema.default("unknown"),
  status: DateFieldStatusSchema.default("unknown"),
  rawText: z.string().nullable().default(null),
  yearInferred: z.boolean().default(false),
});
export type ResolvedDate = z.infer<typeof ResolvedDateSchema>;

/** URL 分類結果 */
export const ClassifiedUrlSchema = z.object({
  originalUrl: z.string(),
  domain: z.string().nullable().default(null),
  urlType: UrlTypeSchema.default("unknown"),
});
export type ClassifiedUrl = z.infer<typeof ClassifiedUrlSchema>;

/** 抽出された1件の抽選（正規化前 Raw 値を保持。正規化は Worker 側） */
export const ExtractedLotterySchema = z.object({
  cardType: CardTypeSchema.default("unknown"),
  productNameRaw: z.string().nullable().default(null),
  storeNameRaw: z.string().nullable().default(null),
  storeBranchRaw: z.string().nullable().default(null),
  region: z.string().nullable().default(null),
  applicationStart: ResolvedDateSchema.default({}),
  applicationEnd: ResolvedDateSchema.default({}),
  /** 「A〜B」形式で当選発表の期間が書かれている場合の開始側（Phase 10）。単一日付のみの投稿ではunknownのまま。 */
  resultAnnouncementStart: ResolvedDateSchema.default({}),
  resultAnnouncement: ResolvedDateSchema.default({}),
  purchaseStart: ResolvedDateSchema.default({}),
  purchaseDeadline: ResolvedDateSchema.default({}),
  /** 「抽選開始されました」だけで開始日時不明のとき、投稿日時を確認済み開始として保持 */
  confirmedOpenAt: z.string().datetime({ offset: true }).nullable().default(null),
  applicationUrl: z.string().nullable().default(null),
  officialInformationUrl: z.string().nullable().default(null),
  appDownloadUrl: z.string().nullable().default(null),
  applicationMethod: z.string().nullable().default(null),
  eligibilityConditions: z.string().nullable().default(null),
  pickupMethod: z.string().nullable().default(null),
  paymentMethod: z.string().nullable().default(null),
  price: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
});
export type ExtractedLottery = z.infer<typeof ExtractedLotterySchema>;

/** 解析結果（scraper が生成し Worker へ送る） */
export const AnalysisInputSchema = z.object({
  postType: PostTypeSchema,
  isLotteryInformation: z.boolean(),
  cardType: CardTypeSchema,
  confidenceScore: z.number().min(0).max(1),
  analysisStatus: AnalysisStatusSchema.default("success"),
  /** ルールパーサのバージョン（記録用）。再解析判定は inputContentHash のみで行う。 */
  parserVersion: z.string(),
  inputContentHash: z.string(),
  extractedLotteries: z.array(ExtractedLotterySchema).default([]),
  urls: z.array(ClassifiedUrlSchema).default([]),
  errorMessage: z.string().nullable().default(null),
});
export type AnalysisInput = z.infer<typeof AnalysisInputSchema>;

/**
 * Claude in Chrome等で手動生成される抽選投稿JSONの入力スキーマ（管理画面「Claude投入」用）。
 * 自動パイプライン（scraper）が送る`ExtractedLotterySchema`と異なり、日時系フィールドは
 * フルの`ResolvedDate`オブジェクト（優先・情報欠落なし）か、ISO datetime文字列/"YYYY-MM-DD"の
 * どちらかを受け付ける。どちらの形にも一致しない文字列（解釈不能な日付表現）は
 * このスキーマの検証自体が失敗する（silentに"unknown"へ丸めない）。
 */
export const ClaudeResolvedDateOrStringSchema = z
  .union([ResolvedDateSchema, z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)])
  .nullable()
  .default(null);

export const ClaudeExtractedLotterySchema = z.object({
  cardType: CardTypeSchema.default("unknown"),
  productNameRaw: z.string().nullable().default(null),
  storeNameRaw: z.string().nullable().default(null),
  storeBranchRaw: z.string().nullable().default(null),
  region: z.string().nullable().default(null),
  applicationStart: ClaudeResolvedDateOrStringSchema,
  applicationEnd: ClaudeResolvedDateOrStringSchema,
  resultAnnouncementStart: ClaudeResolvedDateOrStringSchema,
  resultAnnouncement: ClaudeResolvedDateOrStringSchema,
  purchaseStart: ClaudeResolvedDateOrStringSchema,
  purchaseDeadline: ClaudeResolvedDateOrStringSchema,
  confirmedOpenAt: z.string().datetime({ offset: true }).nullable().default(null),
  applicationUrl: z.string().nullable().default(null),
  officialInformationUrl: z.string().nullable().default(null),
  appDownloadUrl: z.string().nullable().default(null),
  applicationMethod: z.string().nullable().default(null),
  eligibilityConditions: z.string().nullable().default(null),
  pickupMethod: z.string().nullable().default(null),
  paymentMethod: z.string().nullable().default(null),
  price: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
});
export type ClaudeExtractedLottery = z.infer<typeof ClaudeExtractedLotterySchema>;

export const ClaudePostInputSchema = z.object({
  externalPostId: z.string().min(1),
  sourceUrl: z.string().url(),
  publishedAt: z.string().datetime({ offset: true }).nullable().default(null),
  bodyRaw: z.string().default(""),
  postType: PostTypeSchema,
  isLotteryInformation: z.boolean(),
  cardType: CardTypeSchema,
  confidenceScore: z.number().min(0).max(1),
  extractedLotteries: z.array(ClaudeExtractedLotterySchema).default([]),
});
export type ClaudePostInput = z.infer<typeof ClaudePostInputSchema>;

export const IngestPayloadSchema = z.object({
  batchId: z.string().optional(),
  sourcePost: SourcePostInputSchema,
  analysis: AnalysisInputSchema.nullish(),
});

export type IngestPayload = z.infer<typeof IngestPayloadSchema>;

/** /ingest レスポンス */
export const IngestResponseSchema = z.object({
  ok: z.boolean(),
  action: z.enum(["inserted", "updated", "unchanged"]),
  sourcePostId: z.number(),
  externalPostId: z.string(),
  analysis: z
    .object({
      action: z.enum(["inserted", "reused", "failed", "none"]),
      lotteryCount: z.number().default(0),
    })
    .optional(),
});

export type IngestResponse = z.infer<typeof IngestResponseSchema>;
