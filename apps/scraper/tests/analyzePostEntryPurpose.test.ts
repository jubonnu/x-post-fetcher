import { describe, it, expect } from "vitest";
import { analyzePost } from "../src/lottery/analyzePost.ts";
import type { RawPost } from "../src/scraping/x/parseTweetDom.ts";

function makePost(bodyText: string): RawPost {
  return {
    tweetId: "1",
    authorId: null,
    authorUsername: "zabi_poc",
    authorDisplayName: null,
    bodyText,
    publishedAt: "2026-08-19T12:00:00.000Z",
    sourceUrl: "https://x.com/zabi_poc/status/1",
    externalUrls: [],
    externalLinks: [],
    imageUrls: [],
    rawHtml: "",
    cleanedHtml: "",
  };
}

describe("analyzePost: entryPurposeゲート", () => {
  it("6. キーワード非該当 → lottery解析されない（extractedLotteriesが空、isLotteryInformation=false）", async () => {
    const analysis = await analyzePost(
      makePost("8/1(土)トレカ情報まとめ ザビニュース📺\n✅メガレックウザex SAR 90,000円前後で取引中")
    );
    expect(analysis.extractedLotteries).toEqual([]);
    expect(analysis.isLotteryInformation).toBe(false);
  });

  it("new_lotteryキーワードに該当する投稿は従来どおり抽出される", async () => {
    const analysis = await analyzePost(makePost("イオンで「メガドリームex」の抽選開始されました\n応募期間 8/1〜8/10"));
    expect(analysis.extractedLotteries.length).toBeGreaterThan(0);
  });

  it("resultキーワードに該当する投稿は、抽出が完全に成功していてもanalysisStatusがneeds_reviewへ強制される", async () => {
    // 商品名・店舗名が両方揃う「きれいな」抽出ができるケースでも、result投稿は
    // 新規lotteryとして即座に確定登録させない（既存とマッチしなければneeds_reviewへ落ちる）。
    const analysis = await analyzePost(
      makePost("イオンで「メガドリームex」の抽選結果発表\n当選発表 8/15\n応募期間 8/1〜8/10")
    );
    expect(analysis.extractedLotteries.length).toBeGreaterThan(0); // 抽出自体は行われる
    expect(analysis.analysisStatus).toBe("needs_review"); // ただし確定登録はさせない
  });

  it("summaryキーワードに該当する投稿は、抽出が成功すればsuccessのまま（needs_review強制なし）", async () => {
    const analysis = await analyzePost(
      makePost("抽選まとめ\n✅ドラスタで「メガドリームex」8/11 23:59〆\n✅ホビステで「トリプレットビート」8/12 23:59〆")
    );
    expect(analysis.extractedLotteries.length).toBeGreaterThanOrEqual(2);
    expect(analysis.analysisStatus).toBe("success");
  });
});
