import { describe, it, expect } from "vitest";
import { IngestPayloadSchema, SourcePostInputSchema } from "../src/schemas.ts";
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
