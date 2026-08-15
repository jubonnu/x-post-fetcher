import { describe, expect, it } from "vitest";
import { buildLotteryUpdateCandidateKey, disambiguateCandidateKey } from "../src/services/lotteryUpdateCandidateKey.ts";

describe("buildLotteryUpdateCandidateKey", () => {
  it("商品名・店舗名から安定したキーを生成する", () => {
    const key = buildLotteryUpdateCandidateKey({
      normalizedProductName: "MEGAドリームex",
      normalizedStoreName: "ドラゴンスター",
      candidateIndex: 0,
    });
    expect(key).toBe("p:MEGAドリームex|s:ドラゴンスター");
  });

  it("candidateIndexが変わっても商品名・店舗名が同じなら同じキーになる", () => {
    const a = buildLotteryUpdateCandidateKey({
      normalizedProductName: "MEGAドリームex",
      normalizedStoreName: "ドラゴンスター",
      candidateIndex: 0,
    });
    const b = buildLotteryUpdateCandidateKey({
      normalizedProductName: "MEGAドリームex",
      normalizedStoreName: "ドラゴンスター",
      candidateIndex: 3,
    });
    expect(a).toBe(b);
  });

  it("店舗名のみでもキーを生成する", () => {
    const key = buildLotteryUpdateCandidateKey({
      normalizedProductName: null,
      normalizedStoreName: "ドラゴンスター",
      candidateIndex: 0,
    });
    expect(key).toBe("p:|s:ドラゴンスター");
  });

  it("商品名・店舗名がどちらも空の場合のみcandidateIndexにフォールバックする", () => {
    const key = buildLotteryUpdateCandidateKey({
      normalizedProductName: null,
      normalizedStoreName: undefined,
      candidateIndex: 2,
    });
    expect(key).toBe("idx:2");
  });

  it("空白のみの値は空扱いにする", () => {
    const key = buildLotteryUpdateCandidateKey({
      normalizedProductName: "   ",
      normalizedStoreName: "  ",
      candidateIndex: 5,
    });
    expect(key).toBe("idx:5");
  });
});

describe("disambiguateCandidateKey", () => {
  it("1回目（occurrenceIndex=0）はベースキーをそのまま返す（重複が無い投稿では従来通り安定）", () => {
    expect(disambiguateCandidateKey("p:商品|s:店舗", 0)).toBe("p:商品|s:店舗");
  });

  it("2回目以降はサフィックスを付けて一意化する", () => {
    expect(disambiguateCandidateKey("p:商品|s:店舗", 1)).toBe("p:商品|s:店舗#2");
    expect(disambiguateCandidateKey("p:商品|s:店舗", 2)).toBe("p:商品|s:店舗#3");
  });

  it("同じベースキーでもoccurrenceIndexが異なれば異なるキーになる（衝突しない）", () => {
    const keys = [0, 1, 2].map((i) => disambiguateCandidateKey("p:商品|s:店舗", i));
    expect(new Set(keys).size).toBe(3);
  });
});
