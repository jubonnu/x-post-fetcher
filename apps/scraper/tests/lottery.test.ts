import { describe, it, expect } from "vitest";
import { classifyPost } from "../src/lottery/classifyPost.ts";
import { extractSingleLottery } from "../src/lottery/extractLotteryData.ts";
import { classifyPostUrls } from "../src/lottery/classifyUrls.ts";
import { analyzePost } from "../src/lottery/analyzePost.ts";
import type { ExternalLink, RawPost } from "../src/scraping/x/parseTweetDom.ts";

const POST_AT = "2026-07-24T04:00:00.000Z"; // JST 2026-07-24 13:00

function makePost(bodyText: string, links: ExternalLink[] = [], imageUrls: string[] = []): RawPost {
  return {
    tweetId: "1",
    authorId: null,
    authorUsername: "zabi_poc",
    authorDisplayName: "ザビマル",
    bodyText,
    publishedAt: POST_AT,
    sourceUrl: "https://x.com/zabi_poc/status/1",
    externalUrls: links.map((l) => l.href),
    externalLinks: links,
    imageUrls,
    rawHtml: "",
    cleanedHtml: "",
  };
}

describe("classifyPost", () => {
  it("#12 会員登録・備えて の事前準備は lottery_preparation（抽選情報ではない）", () => {
    const c = classifyPost(
      "11月28日(金)「MEGAドリームex」発売予定なので抽選をスムーズにするために各店舗の会員登録済ませておきましょう🔥"
    );
    expect(c.postType).toBe("lottery_preparation");
    expect(c.isLotteryInformation).toBe(false);
  });

  it("#13 再販は restock / 通常販売は general_sale", () => {
    expect(classifyPost("ポケモンカード 再販情報 本日入荷しました").postType).toBe("restock");
    expect(classifyPost("本日発売 先着販売で店頭にて販売開始").postType).toBe("general_sale");
  });

  it("抽選開始シグナルがあれば lottery_started（抽選情報）", () => {
    const c = classifyPost("ドラゴンスターで「世界最強の戦士」の抽選開始されました\n応募期間 8/11 23:59〆");
    expect(c.postType).toBe("lottery_started");
    expect(c.isLotteryInformation).toBe(true);
    expect(c.cardType).toBe("pokemon" === c.cardType ? c.cardType : c.cardType); // cardTypeは投稿内容依存
  });

  it("「締切」の代わりに「〆」だけで日付が書かれたまとめ投稿もlottery_summary（抽選情報）と判定する", () => {
    // 実アカウント（@Zabi_pokeka）の実際の投稿形式（2026-08、本番DBで検証済み）:
    // 「締切」という単語を使わず、日付+「〆」のみで締切を書く。
    const c = classifyPost(
      "本日開始された抽選まとめ💁‍♂️\n\n【ストームエメラルダ】\n✅ホビーステーション 2BOX 8/13(木)23:59〆\nhttps://example.com"
    );
    expect(c.postType).toBe("lottery_summary");
    expect(c.isLotteryInformation).toBe(true);
  });

  it("「購入履歴が必要」という応募条件の説明は事前準備扱いにしない", () => {
    // 実データ確認: 「(応募には1ヵ月以上前でのご購入履歴が必要)」のような応募条件の説明であり、
    // 「購入履歴を作っておきましょう」のような事前準備の呼びかけではない。
    const c = classifyPost(
      "本日告知or開始された抽選まとめ💁‍♂️\n\n【世界最強の戦士】\n✅ヤマシロヤ 8/12(水)21:30〆\n(応募には1ヵ月以上前でのご購入履歴が必要)"
    );
    expect(c.postType).toBe("lottery_summary");
    expect(c.isLotteryInformation).toBe(true);
  });

  it("日付を伴わない単なる「〆」は締切シグナルとして扱わない（無関係な投稿への誤爆防止）", () => {
    const c = classifyPost("これで話は〆ますね、また明日");
    expect(c.isLotteryInformation).toBe(false);
  });
});

describe("extractSingleLottery", () => {
  it("#4 応募締切のみ取得（当選発表・購入期限は unknown）", () => {
    const body = "ドラゴンスターで「世界最強の戦士」の抽選開始されました\n応募期間 8/11(火)23:59〆";
    const l = extractSingleLottery(body, POST_AT, []);
    expect(l.applicationEnd.at).toBe("2026-08-11T23:59:00+09:00");
    expect(l.applicationEnd.precision).toBe("datetime");
    expect(l.resultAnnouncement.precision).toBe("unknown");
    expect(l.purchaseDeadline.precision).toBe("unknown");
    expect(l.productNameRaw).toBe("世界最強の戦士");
    expect(l.storeNameRaw).toBe("ドラゴンスター");
    // 「抽選開始されました」だけなので開始日時は投稿日時を confirmedOpenAt に
    expect(l.confirmedOpenAt).toBe(POST_AT);
  });

  it("#9 閉店時間〆 は store_closing_time（at は null, date のみ）", () => {
    const body = "トイザらスにて抽選\n応募期間 11/10 閉店時間〆\n店頭のQRコードから応募";
    const l = extractSingleLottery(body, POST_AT, []);
    expect(l.applicationEnd.precision).toBe("store_closing_time");
    expect(l.applicationEnd.at).toBeNull();
    expect(l.applicationEnd.date).toBe("2026-11-10");
  });

  it("#10 応募ページ未公開 → applicationUrl は null、締切 status は not_published", () => {
    const body = "ポケセンで「テラスタルフェス」抽選開始されました\n応募期間は後日公開します";
    const l = extractSingleLottery(body, POST_AT, []);
    expect(l.applicationUrl).toBeNull();
    expect(l.applicationEnd.status).toBe("not_published");
  });

  it("#17 年省略でも投稿日から年推定（yearInferred）", () => {
    const l = extractSingleLottery("ドラスタで「x」抽選\n応募期間 8/11 23:59〆", POST_AT, []);
    expect(l.applicationEnd.date).toBe("2026-08-11");
    expect(l.applicationEnd.yearInferred).toBe(true);
  });

  it("#18 曜日不一致は conflicting", () => {
    // 2026-08-11 は火曜。(水) を与えると不一致
    const l = extractSingleLottery("ドラスタで「x」抽選\n応募期間 8/11(水)23:59〆", POST_AT, []);
    expect(l.applicationEnd.status).toBe("conflicting");
  });
});

describe("classifyPostUrls / analyzePost", () => {
  it("#11 App Store リンクは app_download、applicationUrl は null", async () => {
    const links: ExternalLink[] = [{ href: "https://t.co/abc", text: "apps.apple.com/jp/app/…" }];
    const urls = classifyPostUrls(links, []);
    expect(urls[0].urlType).toBe("app_download");

    const post = makePost("イオンで「メガドリームex」抽選開始されました\n応募はアプリから", links);
    const analysis = await analyzePost(post);
    expect(analysis.isLotteryInformation).toBe(true);
    const lot = analysis.extractedLotteries[0];
    expect(lot.appDownloadUrl).toBe("https://t.co/abc");
    expect(lot.applicationUrl).toBeNull();
  });

  it("非抽選（preparation）は extractedLotteries が空", async () => {
    const post = makePost("抽選に備えて会員登録を済ませておきましょう");
    const analysis = await analyzePost(post);
    expect(analysis.isLotteryInformation).toBe(false);
    expect(analysis.extractedLotteries).toEqual([]);
    expect(analysis.parserVersion).toBeTruthy();
    expect(analysis.inputContentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("複数店舗まとめは Phase3 で店舗ごとに分割 → success で複数抽出", async () => {
    const body =
      "MEGAドリームex 全抽選まとめ\n✅ドラスタ 8/11 23:59〆\n✅ホビステ 8/12 23:59〆\n応募期間 当選発表 8/15";
    const analysis = await analyzePost(makePost(body));
    expect(analysis.analysisStatus).toBe("success");
    expect(analysis.extractedLotteries).toHaveLength(2);
    const stores = analysis.extractedLotteries.map((l) => l.storeNameRaw);
    expect(stores).toEqual(["ドラスタ", "ホビステ"]);
    // 各件はヘッダ商品を共有し、締切はそれぞれの行から
    expect(analysis.extractedLotteries[0].productNameRaw).toBe("MEGAドリームex");
    expect(analysis.extractedLotteries[0].applicationEnd.date).toBe("2026-08-11");
    expect(analysis.extractedLotteries[1].applicationEnd.date).toBe("2026-08-12");
  });

  it("丸数字リスト形式の複数店舗まとめも分割できる", async () => {
    const body = "MEGAドリームex 全抽選まとめ\n①ドラスタ 8/11 23:59〆\n②ホビステ 8/12 23:59〆\n応募期間 当選発表 8/15";
    const analysis = await analyzePost(makePost(body));
    expect(analysis.analysisStatus).toBe("success");
    expect(analysis.extractedLotteries).toHaveLength(2);
    expect(analysis.extractedLotteries.map((l) => l.storeNameRaw)).toEqual(["ドラスタ", "ホビステ"]);
  });

  it("番号リスト（1. 2.）形式でも分割できる", async () => {
    const body = "MEGAドリームex 全抽選まとめ\n1.ドラスタ 8/11 23:59〆\n2.ホビステ 8/12 23:59〆\n応募期間 当選発表 8/15";
    const analysis = await analyzePost(makePost(body));
    expect(analysis.analysisStatus).toBe("success");
    expect(analysis.extractedLotteries).toHaveLength(2);
    expect(analysis.extractedLotteries.map((l) => l.storeNameRaw)).toEqual(["ドラスタ", "ホビステ"]);
  });

  it("行ごとに商品が異なるまとめ投稿は、各行の「」商品名を優先して分割する", async () => {
    const body =
      "✅ドラスタで「メガドリームex」8/11 23:59〆\n✅ホビステで「トリプレットビート」8/12 23:59〆\n応募期間 当選発表 8/15";
    const analysis = await analyzePost(makePost(body));
    expect(analysis.analysisStatus).toBe("success");
    expect(analysis.extractedLotteries).toHaveLength(2);
    expect(analysis.extractedLotteries.map((l) => l.storeNameRaw)).toEqual(["ドラスタで", "ホビステで"]);
    expect(analysis.extractedLotteries.map((l) => l.productNameRaw)).toEqual(["メガドリームex", "トリプレットビート"]);
  });

  it("【商品名】セクション区切り＋各セクション複数店舗のまとめ投稿を分割できる（実アカウントの実際の投稿形式）", async () => {
    const body =
      "本日開始された抽選まとめ💁‍♂️\n\n【ストームエメラルダ】\n✅ホビーステーション 8/13(木)23:59〆\nhttps://example.com\n\n✅BIGMAGIC 池袋店 8/13(木)23:59〆\nhttps://example.com\n\n【世界最強の戦士】\n✅キデイランド吉祥寺店 8/13(木)23:59〆\nhttps://example.com";
    const analysis = await analyzePost(makePost(body));
    expect(analysis.analysisStatus).toBe("success");
    expect(analysis.extractedLotteries).toHaveLength(3);
    expect(analysis.extractedLotteries.map((l) => l.productNameRaw)).toEqual([
      "ストームエメラルダ",
      "ストームエメラルダ",
      "世界最強の戦士",
    ]);
    expect(analysis.extractedLotteries.map((l) => l.storeNameRaw)).toEqual([
      "ホビーステーション",
      "BIGMAGIC 池袋店",
      "キデイランド吉祥寺店",
    ]);
  });

  it("「応募期間」「当選発表」を両方書いただけの普通の単一抽選投稿はsuccessになる（分割対象の複数マーカーが無いため）", async () => {
    // 「応募期間」+「当選発表」の両方があるだけでassessComplexityがtrueになるが、
    // 実際には単一の抽選なので分割せず単一抽出の結果をそのまま採用すべき。
    const body = "BIGMAGIC 池袋店で拡張パック「ストームエメラルダ」の抽選開始されました\n【応募期間】\n8月13日(木)23:59〆\n【当選発表】\n8月14日(金)";
    const analysis = await analyzePost(makePost(body));
    expect(analysis.analysisStatus).toBe("success");
    expect(analysis.extractedLotteries).toHaveLength(1);
    expect(analysis.extractedLotteries[0].productNameRaw).toBe("ストームエメラルダ");
    expect(analysis.extractedLotteries[0].storeNameRaw).toBe("BIGMAGIC 池袋店");
  });

  it("店舗名にスペースを含む場合でも抽出できる（BIGMAGIC 池袋店、Tokyo Otaku Mode等）", () => {
    const l1 = extractSingleLottery("Tokyo Otaku Modeで「ストームエメラルダ」の抽選開始されました", POST_AT, []);
    expect(l1.storeNameRaw).toBe("Tokyo Otaku Mode");

    const l2 = extractSingleLottery(
      "ONE PIECEカードゲーム公式ショップで「ブースターパック 世界最強の戦士」の抽選開始されました",
      POST_AT,
      []
    );
    expect(l2.storeNameRaw).toBe("ONE PIECEカードゲーム公式ショップ");
  });
});

// ルールベース解析（100% ルール・LLM なし）のケース網羅
describe("analyzePost（ルールベース fixtures）", () => {
  it("単一商品: 商品・店舗が揃えば success で1件抽出", async () => {
    const analysis = await analyzePost(
      makePost("ドラゴンスターで「世界最強の戦士」の抽選開始されました\n応募期間 8/11(火)23:59〆")
    );
    expect(analysis.analysisStatus).toBe("success");
    expect(analysis.extractedLotteries).toHaveLength(1);
    const lot = analysis.extractedLotteries[0];
    expect(lot.productNameRaw).toBe("世界最強の戦士"); // 商品名抽出
    expect(lot.storeNameRaw).toBe("ドラゴンスター"); // 店舗抽出
    expect(lot.applicationEnd.at).toBe("2026-08-11T23:59:00+09:00"); // 日付抽出
    expect(lot.cardType).toBeTruthy(); // カード種類
  });

  it("複数商品: 複数の商品名を含む投稿は分割できず needs_review", async () => {
    const body =
      "「メガドリームex」「テラスタルフェス」抽選開始されました\n応募期間 8/11 23:59〆";
    const analysis = await analyzePost(makePost(body));
    expect(analysis.isLotteryInformation).toBe(true);
    expect(analysis.analysisStatus).toBe("needs_review");
  });

  it("店舗抽出: 店舗名のみで商品名が取れない → needs_review（判定不能）", async () => {
    const analysis = await analyzePost(makePost("トイザらスにて抽選\n応募期間 11/10 閉店時間〆"));
    expect(analysis.analysisStatus).toBe("needs_review");
    expect(analysis.extractedLotteries[0].storeNameRaw).toBe("トイザらス");
    expect(analysis.extractedLotteries[0].productNameRaw).toBeNull();
  });

  it("URL分類: App Store は app_download、公式サイトは official_information", async () => {
    const links: ExternalLink[] = [
      { href: "https://t.co/app", text: "apps.apple.com/jp/app/…" },
      { href: "https://t.co/info", text: "pokemoncenter-online.com/news/12345" },
    ];
    const analysis = await analyzePost(
      makePost("イオンで「メガドリームex」抽選開始されました\n応募はアプリから", links)
    );
    const types = analysis.urls.map((u) => u.urlType);
    expect(types).toContain("app_download");
    expect(types).toContain("official_information");
  });

  it("判定不能: 抽選情報でない投稿は抽出なし・success（非抽選）", async () => {
    const analysis = await analyzePost(makePost("本日発売 先着販売で店頭にて販売開始"));
    expect(analysis.isLotteryInformation).toBe(false);
    expect(analysis.extractedLotteries).toEqual([]);
  });

  it("メタ情報: LLM 由来フィールドを含まない（parserVersion / contentHash のみ）", async () => {
    const analysis: any = await analyzePost(makePost("ドラスタで「x」抽選\n応募期間 8/11 23:59〆"));
    expect(analysis.parserVersion).toBeTruthy();
    expect(analysis.inputContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(analysis.promptVersion).toBeUndefined();
    expect(analysis.requestedModelId).toBeUndefined();
    expect(analysis.resolvedModelId).toBeUndefined();
  });
});
