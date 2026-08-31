import { computeContentHash, type ClaudeExtractedLottery, type ClaudePostInput, type ExtractedLottery, type IngestPayload, type ResolvedDate } from "@x-post/shared";

/**
 * 管理画面「Claude投入」（手動投入）のparserVersion。自動パイプライン（scraper）の
 * PARSER_VERSION（"phase3-rulesN"）とは別系統の識別子にすることで、両者の再解析判定
 * （inputContentHash + parserVersion）が混ざらないようにする。
 */
export const MANUAL_INGEST_PARSER_VERSION = "manual-claude-in-chrome-v1";

function isResolvedDateObject(value: ResolvedDate | string | null): value is ResolvedDate {
  return typeof value === "object" && value !== null;
}

/**
 * ClaudePostInputSchemaの時点で「ResolvedDateオブジェクト」「ISO datetime文字列」
 * 「'YYYY-MM-DD'文字列」「null」のいずれかであることは検証済み（解釈不能な文字列は
 * スキーマ検証で弾かれ、ここには来ない）。オブジェクトはrawText等を失わずそのまま透過する。
 */
function toResolvedDate(value: ResolvedDate | string | null): ResolvedDate {
  if (value === null) {
    return { at: null, date: null, precision: "unknown", status: "unknown", rawText: null, yearInferred: false };
  }
  if (isResolvedDateObject(value)) {
    return value;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { at: null, date: value, precision: "date_only", status: "extracted", rawText: null, yearInferred: false };
  }
  return { at: value, date: value.slice(0, 10), precision: "datetime", status: "extracted", rawText: null, yearInferred: false };
}

function transformExtractedLottery(input: ClaudeExtractedLottery): ExtractedLottery {
  return {
    cardType: input.cardType,
    productNameRaw: input.productNameRaw,
    storeNameRaw: input.storeNameRaw,
    storeBranchRaw: input.storeBranchRaw,
    region: input.region,
    applicationStart: toResolvedDate(input.applicationStart),
    applicationEnd: toResolvedDate(input.applicationEnd),
    resultAnnouncementStart: toResolvedDate(input.resultAnnouncementStart),
    resultAnnouncement: toResolvedDate(input.resultAnnouncement),
    purchaseStart: toResolvedDate(input.purchaseStart),
    purchaseDeadline: toResolvedDate(input.purchaseDeadline),
    confirmedOpenAt: input.confirmedOpenAt,
    applicationUrl: input.applicationUrl,
    officialInformationUrl: input.officialInformationUrl,
    appDownloadUrl: input.appDownloadUrl,
    applicationMethod: input.applicationMethod,
    eligibilityConditions: input.eligibilityConditions,
    pickupMethod: input.pickupMethod,
    paymentMethod: input.paymentMethod,
    price: input.price,
    notes: input.notes,
  };
}

/**
 * Claude in Chrome入力（flattened形式）を、既存/ingestが受け付ける`IngestPayload`形状へ変換する。
 * contentHash/inputContentHashは自動パイプライン（apps/scraper）と全く同じ`computeContentHash(bodyRaw)`
 * を使う（手動投入分だけ別ロジックのハッシュにならないようにするため）。
 * サーバー側（/admin/claude-ingestルート）専用。admin-webからは呼ばない。
 */
export async function transformClaudePost(input: ClaudePostInput, fetchedAtIso: string): Promise<IngestPayload> {
  const hash = await computeContentHash(input.bodyRaw);

  return {
    sourcePost: {
      platform: "x",
      externalPostId: input.externalPostId,
      authorId: null,
      authorUsername: null,
      authorDisplayName: null,
      bodyRaw: input.bodyRaw,
      publishedAt: input.publishedAt,
      sourceUrl: input.sourceUrl,
      imageUrls: [],
      externalUrls: [],
      rawHtml: "",
      cleanedHtml: "",
      contentHash: hash,
      fetchedAt: fetchedAtIso,
    },
    analysis: {
      postType: input.postType,
      isLotteryInformation: input.isLotteryInformation,
      cardType: input.cardType,
      confidenceScore: input.confidenceScore,
      analysisStatus: "success",
      parserVersion: MANUAL_INGEST_PARSER_VERSION,
      inputContentHash: hash,
      extractedLotteries: input.extractedLotteries.map(transformExtractedLottery),
      urls: [],
      errorMessage: null,
    },
  };
}
