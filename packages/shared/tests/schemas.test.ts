import { describe, it, expect } from "vitest";
import { ClaudePostInputSchema, IngestPayloadSchema, SourcePostInputSchema } from "../src/schemas.ts";
import { computeContentHash } from "../src/utils/hash.ts";
import { extractDomain } from "../src/utils/url.ts";

describe("IngestPayloadSchema", () => {
  const baseSourcePost = {
    externalPostId: "123",
    sourceUrl: "https://x.com/Zabi_pokeka/status/123",
    contentHash: "abc",
    fetchedAt: new Date().toISOString(),
  };

  it("sourcePost のみ（analysis なし）で通る", () => {
    const parsed = IngestPayloadSchema.parse({ sourcePost: baseSourcePost });
    expect(parsed.sourcePost.externalPostId).toBe("123");
    expect(parsed.sourcePost.platform).toBe("x");
    expect(parsed.sourcePost.imageUrls).toEqual([]);
    expect(parsed.analysis).toBeUndefined();
  });

  it("analysis=null でも通る", () => {
    const parsed = IngestPayloadSchema.parse({ sourcePost: baseSourcePost, analysis: null });
    expect(parsed.analysis).toBeNull();
  });

  it("externalPostId が空だと落ちる", () => {
    expect(() =>
      SourcePostInputSchema.parse({ ...baseSourcePost, externalPostId: "" })
    ).toThrow();
  });

  it("sourceUrl が URL でないと落ちる", () => {
    expect(() => SourcePostInputSchema.parse({ ...baseSourcePost, sourceUrl: "not-a-url" })).toThrow();
  });
});

describe("computeContentHash", () => {
  it("同じ本文は同じハッシュ、違う本文は違うハッシュ", async () => {
    const a = await computeContentHash("こんにちは");
    const b = await computeContentHash("こんにちは");
    const c = await computeContentHash("さようなら");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("前後空白は無視する", async () => {
    expect(await computeContentHash("  x  ")).toBe(await computeContentHash("x"));
  });
});

describe("extractDomain", () => {
  it("ホスト名を抽出（www除去）", () => {
    expect(extractDomain("https://www.apps.apple.com/jp/app")).toBe("apps.apple.com");
    expect(extractDomain("https://t.co/abc")).toBe("t.co");
    expect(extractDomain("garbage")).toBeNull();
  });
});

describe("ClaudePostInputSchema", () => {
  const basePost = {
    externalPostId: "123",
    sourceUrl: "https://x.com/Zabi_pokeka/status/123",
    publishedAt: "2026-08-31T11:15:00+09:00",
    bodyRaw: "テスト投稿",
    postType: "lottery_started" as const,
    isLotteryInformation: true,
    cardType: "pokemon" as const,
    confidenceScore: 0.9,
  };

  it("extractedLotteries無しでも通る（無関係投稿）", () => {
    const parsed = ClaudePostInputSchema.parse({
      ...basePost,
      postType: "unrelated",
      isLotteryInformation: false,
      cardType: "unknown",
      confidenceScore: 0.95,
    });
    expect(parsed.extractedLotteries).toEqual([]);
  });

  it("日付フィールドにResolvedDateオブジェクトをそのまま渡せる（rawText等が保持される）", () => {
    const parsed = ClaudePostInputSchema.parse({
      ...basePost,
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
    expect(parsed.extractedLotteries[0].applicationEnd).toEqual({
      at: "2026-09-03T17:59:00+09:00",
      date: "2026-09-03",
      precision: "datetime",
      status: "extracted",
      rawText: "9/3(木)17:59頃〆予定",
      yearInferred: true,
    });
  });

  it("日付フィールドにISO datetime文字列を渡せる（フォールバック）", () => {
    const parsed = ClaudePostInputSchema.parse({
      ...basePost,
      extractedLotteries: [{ applicationEnd: "2026-09-03T17:59:00+09:00" }],
    });
    expect(parsed.extractedLotteries[0].applicationEnd).toBe("2026-09-03T17:59:00+09:00");
  });

  it("日付フィールドに'YYYY-MM-DD'文字列を渡せる（フォールバック）", () => {
    const parsed = ClaudePostInputSchema.parse({
      ...basePost,
      extractedLotteries: [{ applicationEnd: "2026-09-03" }],
    });
    expect(parsed.extractedLotteries[0].applicationEnd).toBe("2026-09-03");
  });

  it("日付フィールドにnullを渡せる（未入力扱い）", () => {
    const parsed = ClaudePostInputSchema.parse({
      ...basePost,
      extractedLotteries: [{ applicationEnd: null }],
    });
    expect(parsed.extractedLotteries[0].applicationEnd).toBeNull();
  });

  it("解釈不能な日付表現はバリデーション自体が失敗する（silentにunknownへ丸めない）", () => {
    expect(() =>
      ClaudePostInputSchema.parse({
        ...basePost,
        extractedLotteries: [{ applicationEnd: "9月頃" }],
      })
    ).toThrow();
  });
});
