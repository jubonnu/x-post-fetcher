import { z } from "zod";

/**
 * `user_lotteries.snapshotJson`へ保存してよい形状（Mobile-G2B-2）。
 *
 * 公開`GET /lotteries`・`GET /lotteries/:id`が返す形状（`apps/mobile/schemas/lotteryApi.ts`の
 * `lotteryRecordSchema`と対応）に厳密に一致させる。これにより:
 * - モバイル側が実際に保持しているデータ（このAPIレスポンスのスナップショット）以外は
 *   構造的に保存できない
 * - `source_posts.bodyRaw`/`rawHtml`等、X投稿本文や生データはこの形状に含まれないため
 *   `.strict()`で余剰フィールドを拒否することで確実に排除される
 */
export const lotterySnapshotSchema = z
  .object({
    id: z.number(),
    sourcePostId: z.number().nullable(),
    productNameRaw: z.string().max(500).nullable(),
    normalizedProductName: z.string().max(500).nullable(),
    cardType: z.string().max(50).nullable(),
    storeNameRaw: z.string().max(500).nullable(),
    normalizedStoreName: z.string().max(500).nullable(),
    storeBranchRaw: z.string().max(500).nullable(),
    normalizedStoreBranch: z.string().max(500).nullable(),
    region: z.string().max(200).nullable(),
    normalizerVersion: z.string().max(100).nullable(),
    applicationStartAt: z.string().max(100).nullable(),
    confirmedOpenAt: z.string().max(100).nullable(),
    applicationEndAt: z.string().max(100).nullable(),
    applicationEndDate: z.string().max(100).nullable(),
    applicationEndPrecision: z.string().max(50).nullable(),
    resultAnnouncementAt: z.string().max(100).nullable(),
    resultAnnouncementDate: z.string().max(100).nullable(),
    resultAnnouncementPrecision: z.string().max(50).nullable(),
    purchaseStartAt: z.string().max(100).nullable(),
    purchaseDeadlineAt: z.string().max(100).nullable(),
    applicationUrl: z.string().max(2000).nullable(),
    resolvedApplicationUrl: z.string().max(2000).nullable(),
    applicationUrlHttpStatus: z.number().nullable(),
    urlResolvedAt: z.string().max(100).nullable(),
    officialInformationUrl: z.string().max(2000).nullable(),
    appDownloadUrl: z.string().max(2000).nullable(),
    applicationMethod: z.string().max(2000).nullable(),
    eligibilityConditions: z.string().max(2000).nullable(),
    pickupMethod: z.string().max(2000).nullable(),
    paymentMethod: z.string().max(500).nullable(),
    price: z.string().max(200).nullable(),
    status: z.string().max(50).nullable(),
    completenessScore: z.string().max(20).nullable(),
    verificationStatus: z.string().max(50).nullable(),
    approvedBy: z.string().max(200).nullable(),
    approvedAt: z.string().max(100).nullable(),
    rejectedReason: z.string().max(2000).nullable(),
    rejectedAt: z.string().max(100).nullable(),
    lifecycleStatus: z.string().max(50),
    orphanedAt: z.string().max(100).nullable(),
    createdAt: z.string().max(100),
    updatedAt: z.string().max(100),
  })
  .strict();

export type LotterySnapshot = z.infer<typeof lotterySnapshotSchema>;

/** シリアライズ後のバイト数上限（8KB）。上記フィールド上限を全て使い切っても超えない想定の防御的上限。 */
export const SNAPSHOT_MAX_BYTES = 8192;

export class SnapshotTooLargeError extends Error {
  constructor() {
    super(`snapshotJsonが上限（${SNAPSHOT_MAX_BYTES}バイト）を超えています`);
    this.name = "SnapshotTooLargeError";
  }
}

/** 検証済みsnapshotをJSON文字列化し、サイズ上限を確認する。超過時は例外を投げる。 */
export function serializeSnapshot(snapshot: LotterySnapshot): string {
  const json = JSON.stringify(snapshot);
  if (new TextEncoder().encode(json).length > SNAPSHOT_MAX_BYTES) {
    throw new SnapshotTooLargeError();
  }
  return json;
}
