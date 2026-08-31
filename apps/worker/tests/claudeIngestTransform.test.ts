import { describe, it, expect } from "vitest";
import { ClaudePostInputSchema, IngestPayloadSchema, computeContentHash } from "@x-post/shared";
import { MANUAL_INGEST_PARSER_VERSION, transformClaudePost } from "../src/services/claudeIngestTransform.ts";

const FETCHED_AT = "2026-09-01T09:00:00+09:00";

describe("transformClaudePost", () => {
  it("ResolvedDateオブジェクトはrawText等を失わずそのまま透過する", async () => {
    const input = ClaudePostInputSchema.parse({
      externalPostId: "1",
      sourceUrl: "https://x.com/Zabi_pokeka/status/1",
      publishedAt: "2026-08-31T11:15:00+09:00",
      bodyRaw: "テスト投稿",
      postType: "lottery_started",
      isLotteryInformation: true,
      cardType: "pokemon",
      confidenceScore: 0.9,
      extractedLotteries: [
        {
          productNameRaw: "商品A",
          applicationEnd: {
            at: "2026-09-03T17:59:00+09:00",
            date: "2026-09-03",
            precision: "datetime",
            status: "extracted",
            rawText: "9/3(木)17:59頃〆予定",
            yearInferred: true,
          },
        },
      ],
    });

    const payload = await transformClaudePost(input, FETCHED_AT);
    expect(payload.analysis?.extractedLotteries[0].applicationEnd).toEqual({
      at: "2026-09-03T17:59:00+09:00",
      date: "2026-09-03",
      precision: "datetime",
      status: "extracted",
      rawText: "9/3(木)17:59頃〆予定",
      yearInferred: true,
    });
  });

  it("ISO datetime文字列からResolvedDateを組み立てる", async () => {
    const input = ClaudePostInputSchema.parse({
      externalPostId: "2",
      sourceUrl: "https://x.com/Zabi_pokeka/status/2",
      bodyRaw: "テスト投稿2",
      postType: "lottery_started",
      isLotteryInformation: true,
      cardType: "pokemon",
      confidenceScore: 0.9,
      extractedLotteries: [{ applicationEnd: "2026-09-03T17:59:00+09:00" }],
    });

    const payload = await transformClaudePost(input, FETCHED_AT);
    expect(payload.analysis?.extractedLotteries[0].applicationEnd).toEqual({
      at: "2026-09-03T17:59:00+09:00",
      date: "2026-09-03",
      precision: "datetime",
      status: "extracted",
      rawText: null,
      yearInferred: false,
    });
  });

  it("'YYYY-MM-DD'文字列からResolvedDateを組み立てる", async () => {
    const input = ClaudePostInputSchema.parse({
      externalPostId: "3",
      sourceUrl: "https://x.com/Zabi_pokeka/status/3",
      bodyRaw: "テスト投稿3",
      postType: "lottery_started",
      isLotteryInformation: true,
      cardType: "pokemon",
      confidenceScore: 0.9,
      extractedLotteries: [{ applicationEnd: "2026-09-03" }],
    });

    const payload = await transformClaudePost(input, FETCHED_AT);
    expect(payload.analysis?.extractedLotteries[0].applicationEnd).toEqual({
      at: null,
      date: "2026-09-03",
      precision: "date_only",
      status: "extracted",
      rawText: null,
      yearInferred: false,
    });
  });

  it("nullは未入力扱い（unknown）になる", async () => {
    const input = ClaudePostInputSchema.parse({
      externalPostId: "4",
      sourceUrl: "https://x.com/Zabi_pokeka/status/4",
      bodyRaw: "テスト投稿4",
      postType: "lottery_started",
      isLotteryInformation: true,
      cardType: "pokemon",
      confidenceScore: 0.9,
      extractedLotteries: [{ applicationEnd: null }],
    });

    const payload = await transformClaudePost(input, FETCHED_AT);
    expect(payload.analysis?.extractedLotteries[0].applicationEnd).toEqual({
      at: null,
      date: null,
      precision: "unknown",
      status: "unknown",
      rawText: null,
      yearInferred: false,
    });
  });

  it("contentHash/inputContentHashは自動パイプラインと同じcomputeContentHash(bodyRaw)を使う", async () => {
    const input = ClaudePostInputSchema.parse({
      externalPostId: "5",
      sourceUrl: "https://x.com/Zabi_pokeka/status/5",
      bodyRaw: "ハッシュ確認用の本文",
      postType: "unrelated",
      isLotteryInformation: false,
      cardType: "unknown",
      confidenceScore: 0.95,
    });

    const payload = await transformClaudePost(input, FETCHED_AT);
    const expectedHash = await computeContentHash("ハッシュ確認用の本文");
    expect(payload.sourcePost.contentHash).toBe(expectedHash);
    expect(payload.analysis?.inputContentHash).toBe(expectedHash);
  });

  it("parserVersionは手動投入専用の固定値", async () => {
    const input = ClaudePostInputSchema.parse({
      externalPostId: "6",
      sourceUrl: "https://x.com/Zabi_pokeka/status/6",
      bodyRaw: "本文",
      postType: "unrelated",
      isLotteryInformation: false,
      cardType: "unknown",
      confidenceScore: 0.95,
    });

    const payload = await transformClaudePost(input, FETCHED_AT);
    expect(payload.analysis?.parserVersion).toBe(MANUAL_INGEST_PARSER_VERSION);
  });

  it("出力はIngestPayloadSchemaにそのまま適合する", async () => {
    const input = ClaudePostInputSchema.parse({
      externalPostId: "7",
      sourceUrl: "https://x.com/Zabi_pokeka/status/7",
      publishedAt: "2026-08-31T11:08:00+09:00",
      bodyRaw: "ヨドバシドットコムで「30th CELEBRATION/プレミアムデッキセット」の抽選開始されました🔥",
      postType: "lottery_started",
      isLotteryInformation: true,
      cardType: "pokemon",
      confidenceScore: 0.9,
      extractedLotteries: [
        {
          productNameRaw: "30th CELEBRATION/プレミアムデッキセット",
          storeNameRaw: "ヨドバシドットコム",
          applicationEnd: "2026-09-01T10:59:00+09:00",
          applicationUrl: "https://limited.yodobashi.com",
        },
      ],
    });

    const payload = await transformClaudePost(input, FETCHED_AT);
    expect(IngestPayloadSchema.safeParse(payload).success).toBe(true);
  });
});
