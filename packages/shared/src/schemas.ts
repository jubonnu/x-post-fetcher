import { z } from "zod";

/**
 * /ingest の payload スキーマ（Phase 1）。
 *
 * - sourcePost: X から取得した生データ（必須）
 * - analysis:  解析結果（Phase 2 以降。Phase 1 では未使用のため null/省略を許容）
 *
 * ※ 「sourcePost のみでも受信できる」ようにするため analysis は nullable/optional。
 */

export const SourcePostInputSchema = z.object({
  platform: z.literal("x").default("x"),
  /** tweetId（externalPostId） */
  externalPostId: z.string().min(1),
  authorId: z.string().nullable().default(null),
  authorUsername: z.string().nullable().default(null),
  authorDisplayName: z.string().nullable().default(null),
  /** 投稿本文（プレーンテキスト） */
  bodyRaw: z.string().default(""),
  /** 投稿日時（ISO8601）。取得できない場合 null */
  publishedAt: z.string().datetime({ offset: true }).nullable().default(null),
  /** 投稿URL */
  sourceUrl: z.string().url(),
  /** 画像URL（バイナリはDLせずURLのみ） */
  imageUrls: z.array(z.string()).default([]),
  /** 本文内リンク（t.co 等の生 href） */
  externalUrls: z.array(z.string()).default([]),
  /** 対象 article の加工前HTML */
  rawHtml: z.string().default(""),
  /** メディア等を除去したHTML */
  cleanedHtml: z.string().default(""),
  /** 本文のハッシュ（変更検知用） */
  contentHash: z.string().min(1),
  /** 取得日時（ISO8601） */
  fetchedAt: z.string().datetime({ offset: true }),
});

export type SourcePostInput = z.infer<typeof SourcePostInputSchema>;

/**
 * Phase 1 では解析結果は扱わないため、受け取っても無視する permissive な型。
 * Phase 2 で正式スキーマに置き換える。
 */
export const AnalysisInputSchema = z.unknown().nullish();

export const IngestPayloadSchema = z.object({
  batchId: z.string().optional(),
  sourcePost: SourcePostInputSchema,
  analysis: AnalysisInputSchema,
});

export type IngestPayload = z.infer<typeof IngestPayloadSchema>;

/** /ingest レスポンス */
export const IngestResponseSchema = z.object({
  ok: z.boolean(),
  action: z.enum(["inserted", "updated", "unchanged"]),
  sourcePostId: z.number(),
  externalPostId: z.string(),
});

export type IngestResponse = z.infer<typeof IngestResponseSchema>;
