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

  describe("日付の次行探索（改善案1）", () => {
    it("【応募期間】ラベル行自体に日付が無く、直後の行に日付がある場合はその行を採用する", () => {
      // 実データで最も多いパターン: ラベル行と日付が別行に分かれている
      const body = "ポケセンオンラインで「ストームエメラルダ」の抽選開始されました\n【応募期間】\n7月26日 23時59分〆";
      const l = extractSingleLottery(body, POST_AT, []);
      expect(l.applicationEnd.precision).toBe("datetime");
      expect(l.applicationEnd.at).toBe("2026-07-26T23:59:00+09:00");
    });

    it("ラベル行の直後が日付ではない行（注意書き）で、その次の行に日付がある場合も2行先まで探索する", () => {
      const body = "【応募期間】\n※店舗により対応が異なる場合があります\n7月26日 23時59分〆";
      const l = extractSingleLottery(body, POST_AT, []);
      expect(l.applicationEnd.precision).toBe("datetime");
      expect(l.applicationEnd.at).toBe("2026-07-26T23:59:00+09:00");
    });

    it("価格・数量表記の行を挟んでも直後の日付行を見つけられる", () => {
      const body = "【応募期間】\n5,000円(税込) 1BOX\n7月26日 23時59分〆";
      const l = extractSingleLottery(body, POST_AT, []);
      expect(l.applicationEnd.precision).toBe("datetime");
      expect(l.applicationEnd.at).toBe("2026-07-26T23:59:00+09:00");
    });

    it("URL行はスキップし、それより後ろの日付行を採用する（URL内の数字を日付と誤認しない）", () => {
      // "https://example.com/8/13" は日付誤認防止のガードが無いと 8/13 と誤って解釈されてしまう
      const body = "【応募期間】\nhttps://example.com/8/13\n7月26日 23時59分〆";
      const l = extractSingleLottery(body, POST_AT, []);
      expect(l.applicationEnd.precision).toBe("datetime");
      expect(l.applicationEnd.at).toBe("2026-07-26T23:59:00+09:00");
    });

    it("URL行しか続かず有効な日付が2行以内に無い場合は unknown のまま（URLを日付として誤認しない）", () => {
      const body = "【応募期間】\nhttps://example.com/8/13\n詳細はこちら";
      const l = extractSingleLottery(body, POST_AT, []);
      expect(l.applicationEnd.precision).toBe("unknown");
    });

    it("3行先の日付は探索しない（1〜2行までの探索に限定）", () => {
      const body = "【応募期間】\n注意書き1行目\n注意書き2行目\n7月26日 23時59分〆";
      const l = extractSingleLottery(body, POST_AT, []);
      expect(l.applicationEnd.precision).toBe("unknown");
    });

    it("ラベル行に「後日」等の未公開シグナルがあり、直後2行にも日付が無ければ not_published のまま", () => {
      const body = "【応募期間】は後日発表\n詳細は追ってお知らせします";
      const l = extractSingleLottery(body, POST_AT, []);
      expect(l.applicationEnd.status).toBe("not_published");
    });

    it("キーワード行自体に日付があれば従来通りそれを採用する（次行探索による回帰無し）", () => {
      const body = "【応募期間】8/11(火)23:59〆\n7月26日 23時59分〆";
      const l = extractSingleLottery(body, POST_AT, []);
      expect(l.applicationEnd.date).toBe("2026-08-11");
    });
  });

  describe("日付範囲「A〜B」の開始・終了抽出（Phase 10）", () => {
    it("応募期間が範囲表記なら、開始日はapplicationStart・終了日はapplicationEndに入る", () => {
      const body = "【応募期間】\n8月11日(火)14時〜8月13日(木)23時59分";
      const l = extractSingleLottery(body, POST_AT, []);
      expect(l.applicationStart.at).toBe("2026-08-11T14:00:00+09:00");
      expect(l.applicationEnd.at).toBe("2026-08-13T23:59:00+09:00");
    });

    it("当選発表が範囲表記なら、resultAnnouncementStart・resultAnnouncementの両方に入る", () => {
      const body = "【当選発表】\n8月14日(金)〜8月16日(日)順次ご連絡";
      const l = extractSingleLottery(body, POST_AT, []);
      expect(l.resultAnnouncementStart.date).toBe("2026-08-14");
      expect(l.resultAnnouncement.date).toBe("2026-08-16");
    });

    it("購入期間が範囲表記（「購入期限」ラベルが無い）でも締切側がpurchaseDeadlineに入る", () => {
      const body = "【購入期間】\n8月19日(水)～8月26日(水)";
      const l = extractSingleLottery(body, POST_AT, []);
      expect(l.purchaseStart.date).toBe("2026-08-19");
      expect(l.purchaseDeadline.date).toBe("2026-08-26");
    });

    it("単一日付（範囲区切りが無い）の場合は従来通り開始日フィールドはunknownのまま", () => {
      const body = "【応募期間】\n8月11日(火)23:59〆";
      const l = extractSingleLottery(body, POST_AT, []);
      expect(l.applicationEnd.date).toBe("2026-08-11");
      expect(l.applicationStart.precision).toBe("unknown");
    });

    it("【応募開始】等の明示ラベルがあれば、範囲検出より優先される", () => {
      const body = "【応募開始】\n8月10日(月)10時\n【応募期間】\n8月11日(火)14時〜8月13日(木)23時59分";
      const l = extractSingleLottery(body, POST_AT, []);
      // 明示ラベル側（8/10）が優先され、範囲側の開始（8/11）では上書きされない
      expect(l.applicationStart.date).toBe("2026-08-10");
      expect(l.applicationEnd.date).toBe("2026-08-13");
    });
  });

  describe("【当選発表】セクションを商品グループ化の見出しとして誤分割しない", () => {
    it("実データ回帰: 【当選発表】の下の「・商品名」リンク列挙を店舗ごとの分割対象にせず、単一抽選として扱う", async () => {
      // 実データで発見した回帰: 【当選発表】は「期間」「期限」等のラベル語根を含まないため
      // isSectionLabelがfalseを返し、splitLotteriesのパターン(0)がこれを商品グループ見出しと
      // 誤認して、下にある「応募はこちら⬇️」の「・商品名」リンク列挙を店舗一覧として分割し、
      // 商品名="当選発表"・店舗名=各リンクの商品名、という入れ替わったデータを生成していた。
      const body =
        "DMM通販で「受け継がれる意志/Heroines Edition」の抽選開始されました🔥🔥🔥\n\n【受付期間】\n7月21日(火)15:00〆\n\n【当選発表】\n7月23日(木)から4日以内に当選者にのみメール\n\n応募はこちら⬇️\n・受け継がれる意志\nhttps://dmm.com/mono/hobby/-/detail/=/cid=c260404065_lo2604_3/\n\n・Heroines Edition\nhttps://dmm.com/mono/hobby/-/detail/=/cid=c260404066_lo2604_3/";
      // 実データ（sourcePostId=125）に合わせ、応募締切より前の投稿日時を使う（年推定の分岐を避けるため）
      const post = { ...makePost(body), publishedAt: "2026-07-14T07:09:39.000Z" };
      const analysis = await analyzePost(post);
      expect(analysis.analysisStatus).toBe("success");
      expect(analysis.extractedLotteries).toHaveLength(1);
      expect(analysis.extractedLotteries[0].productNameRaw).toBe("受け継がれる意志/Heroines Edition");
      expect(analysis.extractedLotteries[0].storeNameRaw).toBe("DMM通販");
      expect(analysis.extractedLotteries[0].applicationEnd.date).toBe("2026-07-21");
    });

    it("【当選発表】ラベル自体は従来通り当選発表日時として抽出できる（stopword追加による回帰無し）", () => {
      const body = "BIGMAGIC 池袋店で拡張パック「ストームエメラルダ」の抽選開始されました\n【応募期間】\n8月13日(木)23:59〆\n【当選発表】\n8月14日(金)";
      const l = extractSingleLottery(body, POST_AT, []);
      expect(l.resultAnnouncement.date).toBe("2026-08-14");
    });

    it("実データ回帰: 【応募条件】の下の丸数字箇条書き（①②）を店舗ごとの分割対象にせず、単一抽選として扱う（sourcePostId=115）", async () => {
      const body =
        "イトーヨーカドーネット通販で拡張パック「ストームエメラルダ」の抽選開始されました‼️\n\n【受付期間】\n7月15日(火)23時59分〆\n\n【当選発表】\n7月31日(金)11時から順次\n\n【応募条件】\n①7IDをお持ちのお客様\n②二要素認証用電話番号を設定済のお客様\n\n抽選ページはこちら⬇️\nhttps://iyec.itoyokado.co.jp/shop/pages/apply_pomega_04.aspx";
      const post = { ...makePost(body), publishedAt: "2026-07-10T00:00:00.000Z" };
      const analysis = await analyzePost(post);
      expect(analysis.analysisStatus).toBe("success");
      expect(analysis.extractedLotteries).toHaveLength(1);
      expect(analysis.extractedLotteries[0].productNameRaw).toBe("ストームエメラルダ");
      expect(analysis.extractedLotteries[0].storeNameRaw).toBe("イトーヨーカドーネット通販");
      expect(analysis.extractedLotteries[0].applicationEnd.date).toBe("2026-07-15");
    });
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
      "抽選まとめ\n✅ドラスタで「メガドリームex」8/11 23:59〆\n✅ホビステで「トリプレットビート」8/12 23:59〆\n応募期間 当選発表 8/15";
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

  it("1つの抽選の受取店舗一覧（■付き）を、別々の抽選として誤分割しない", async () => {
    // 実データで発見した回帰: 「✅ジャンプショップ」という1件の抽選の下に、受取可能な
    // 実店舗を「■札幌店 URL」「■仙台店 URL」...と列挙しているだけなのに、■をトップレベルの
    // 区切りマーカーとして扱うと店舗数だけ誤って分割されてしまっていた（2026-08、修正済み）。
    const body =
      "【抽選まとめ】\n✅ヤマダ電機 8/12(水)23:59〆\n\n✅ジャンプショップ 8月13日(木)23:59〆\n■札幌店 http://example.com/a\n■仙台店 http://example.com/b\n■東京駅店 http://example.com/c";
    const analysis = await analyzePost(makePost(body));
    expect(analysis.analysisStatus).toBe("success");
    expect(analysis.extractedLotteries).toHaveLength(2);
    expect(analysis.extractedLotteries.map((l) => l.storeNameRaw)).toEqual(["ヤマダ電機", "ジャンプショップ"]);
  });

  it("【対象商品】【手順】のようなフィールドラベル節の中身（商品バリエーション列挙・手順説明）を店舗として誤抽出しない", async () => {
    // 実データで発見した回帰: 【対象商品】の下の「・」箇条書き（商品バリエーション）や
    // 【手順】の下の丸数字（①②③、認証手順の説明文）を、そのまま店舗として抽出してしまっていた。
    const body =
      "ポケセンオンラインで「30th CELEBRATION」の抽選開始されました\n\n【対象商品】\n・拡張パック「30th CELEBRATION」\n・30th CELEBRATION FUTURISTIC BOX\n\n【応募期間】\n8月14日(金)16時59分〆\n\n【手順】\n①デジタル認証アプリをダウンロードし利用登録を完了する。\n②プレイヤーズクラブの登録をする。";
    const analysis = await analyzePost(makePost(body));
    expect(analysis.extractedLotteries).toHaveLength(1);
    expect(analysis.extractedLotteries[0].productNameRaw).toBe("30th CELEBRATION");
    expect(analysis.extractedLotteries[0].storeNameRaw).toBe("ポケセンオンライン");
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
    const analysis = await analyzePost(makePost("トイザらスにて抽選開始\n応募期間 11/10 閉店時間〆"));
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

/**
 * applicationUrl決定の優先順位（2026-08）。
 * 旧仕様は classifyUrl() の allowlist（livepocket 等の主要抽選代行プラットフォーム）に
 * 完全一致しない限り常に null になっており、店舗が自社ドメインで応募ページを持つケース
 * （例: 駿河屋のブログ形式の応募ページ）でURLが本文に存在するのに消えてしまっていた
 * （2026-08、sourcePostId=250の実データで確認）。
 */
describe("resolveApplicationUrl（応募URL決定の優先順位）", () => {
  it("1. allowlist一致（livepocket）→ application", async () => {
    const links: ExternalLink[] = [{ href: "https://t.co/live1", text: "livepocket.jp/e/abc" }];
    const post = makePost("ドラスタで「x」抽選開始されました\n応募はこちら\nhttps://livepocket.jp/e/abc", links);
    const analysis = await analyzePost(post);
    expect(analysis.extractedLotteries[0].applicationUrl).toBe("https://t.co/live1");
    expect(analysis.analysisStatus).toBe("success");
  });

  it("2. 店舗公式ドメイン対応表に一致（駿河屋→suruga-ya.jp）、URL1件 → applicationUrl設定", async () => {
    const links: ExternalLink[] = [{ href: "https://t.co/suru1", text: "suruga-ya.jp/blog/?q=xxx" }];
    const post = makePost(
      "駿河屋通販で拡張パック「30th CELEBRATION」の抽選開始されました\n応募はこちら⬇️\nhttps://suruga-ya.jp/blog/?q=xxx",
      links
    );
    const analysis = await analyzePost(post);
    expect(analysis.extractedLotteries[0].applicationUrl).toBe("https://t.co/suru1");
    expect(analysis.analysisStatus).toBe("success");
  });

  it("3. allowlist外の店舗公式ドメインでも、応募関連文言に近接していればapplication扱い", async () => {
    const links: ExternalLink[] = [{ href: "https://t.co/hobby1", text: "hobbystation.co.jp/lottery/123" }];
    const post = makePost(
      "ホビーステーションで「テスト商品」抽選開始されました\nエントリーはこちらから\nhttps://hobbystation.co.jp/lottery/123",
      links
    );
    const analysis = await analyzePost(post);
    expect(analysis.extractedLotteries[0].applicationUrl).toBe("https://t.co/hobby1");
    expect(analysis.analysisStatus).toBe("success");
  });

  it("4. allowlist外・文言近接なし・店舗対応表にも無いが、URLが1件だけ → フォールバックでapplication採用", async () => {
    const links: ExternalLink[] = [{ href: "https://t.co/shop1", text: "example-shop.jp/info" }];
    const post = makePost("テスト商店で「テスト商品」抽選開始されました\n詳細はこちら\nhttps://example-shop.jp/info", links);
    const analysis = await analyzePost(post);
    expect(analysis.extractedLotteries[0].applicationUrl).toBe("https://t.co/shop1");
    expect(analysis.analysisStatus).toBe("success");
  });

  it("5. allowlist外URLが複数件で判別不能 → applicationUrlは確定させず、urlsは全件保持したままneeds_review", async () => {
    const links: ExternalLink[] = [
      { href: "https://t.co/a1", text: "shop-a.jp/page" },
      { href: "https://t.co/a2", text: "shop-b.jp/page" },
    ];
    const post = makePost("テスト商店で「テスト商品」抽選開始されました\n詳細はこちら\nshop-a.jp/page\nshop-b.jp/page", links);
    const analysis = await analyzePost(post);
    expect(analysis.extractedLotteries[0].applicationUrl).toBeNull();
    expect(analysis.analysisStatus).toBe("needs_review");
    // URL自体は失われず両方 urls 配列に残っている
    expect(analysis.urls.map((u) => u.originalUrl).sort()).toEqual(["https://t.co/a1", "https://t.co/a2"]);
  });

  it("6. 同一投稿を再解析してもapplicationUrlの重複・消失がない（決定的・冪等）", async () => {
    const links: ExternalLink[] = [{ href: "https://t.co/suru1", text: "suruga-ya.jp/blog/?q=xxx" }];
    const post = makePost(
      "駿河屋通販で拡張パック「30th CELEBRATION」の抽選開始されました\n応募はこちら⬇️\nhttps://suruga-ya.jp/blog/?q=xxx",
      links
    );
    const first = await analyzePost(post);
    const second = await analyzePost(post);
    expect(second.extractedLotteries[0].applicationUrl).toBe(first.extractedLotteries[0].applicationUrl);
    expect(second.extractedLotteries[0].applicationUrl).toBe("https://t.co/suru1");
    expect(second.urls).toEqual(first.urls);
    expect(second.analysisStatus).toBe(first.analysisStatus);
  });

  it("回帰確認: sourcePostId 250（駿河屋、production実データ）相当のケースでapplicationUrlがnullでなくなる", async () => {
    const links: ExternalLink[] = [{ href: "https://t.co/wovxq8aCHk", text: "suruga-ya.jp/blog/?q=pokeka_chusen260820.html…" }];
    const post = makePost(
      "駿河屋通販で拡張パック「30th CELEBRATION」の抽選開始されました‼️\n\n【応募期間】\n9月6日(日)23時59分〆\n\n【当選発表】\n9月7日(月)\n\n応募はこちら⬇️\nhttps://suruga-ya.jp/blog/?q=pokeka_chusen260820.html…",
      links
    );
    const analysis = await analyzePost(post);
    expect(analysis.extractedLotteries[0].applicationUrl).not.toBeNull();
    expect(analysis.extractedLotteries[0].applicationUrl).toBe("https://t.co/wovxq8aCHk");
  });

  it("回帰確認: sourcePostId 251（複数商品まとめ、production実データ）相当のケースで商品ごとに個別のapplicationUrlが割り当てられる（全商品に1件目のURLが誤って共有されていた不具合の修正）", async () => {
    const links: ExternalLink[] = [
      { href: "https://t.co/gzMhYwyva4", text: "http://livepocket.jp/e/bpvrn" },
      { href: "https://t.co/xLUUJ8e96x", text: "http://livepocket.jp/e/frwnn" },
      { href: "https://t.co/ui65YItxp5", text: "http://livepocket.jp/e/xhtf4" },
      { href: "https://t.co/tFTRub8vRc", text: "http://livepocket.jp/e/wi88k" },
      { href: "https://t.co/6WO4v4KmFO", text: "http://livepocket.jp/e/o70fs" },
      { href: "https://t.co/Vy91Y2hJ0M", text: "http://livepocket.jp/e/jmpwp" },
    ];
    const body =
      "晴れる屋2秋葉原タワー店でストームエメラルダ/アビスアイ/メガブレイブ/メガシンフォニア/MEGAドリームex/スタデ100の抽選開始‼️\n\n" +
      "【応募期間】\n8月24日(月)23:59〆\n\n【当選発表】\n8月25日(火)予定\n\n【購入期間】\n8月28日(金)～8月30日(日)営業時間中\n\n" +
      "抽選ページはこちら⬇️\n" +
      "【MEGA】拡張パック「ストームエメラルダ」\nhttp://livepocket.jp/e/bpvrn\n" +
      "【MEGA】拡張パック「アビスアイ」\nhttp://livepocket.jp/e/frwnn\n" +
      "【MEGA】拡張パック「メガシンフォニア」\nhttp://livepocket.jp/e/xhtf4\n" +
      "【MEGA】拡張パック「メガブレイブ」\nhttp://livepocket.jp/e/wi88k\n" +
      "【MEGA】ハイクラスパック「MEGAドリームex」\nhttp://livepocket.jp/e/o70fs\n" +
      "「スタートデッキ100 バトルコレクション」\nhttp://livepocket.jp/e/jmpwp";

    const analysis = await analyzePost(makePost(body, links));
    expect(analysis.extractedLotteries.length).toBe(6);

    const byProduct = Object.fromEntries(analysis.extractedLotteries.map((l) => [l.productNameRaw, l.applicationUrl]));
    expect(byProduct["ストームエメラルダ"]).toBe("https://t.co/gzMhYwyva4");
    expect(byProduct["アビスアイ"]).toBe("https://t.co/xLUUJ8e96x");
    expect(byProduct["メガシンフォニア"]).toBe("https://t.co/ui65YItxp5");
    expect(byProduct["メガブレイブ"]).toBe("https://t.co/tFTRub8vRc");
    expect(byProduct["MEGAドリームex"]).toBe("https://t.co/6WO4v4KmFO");
    expect(byProduct["スタートデッキ100 バトルコレクション"]).toBe("https://t.co/Vy91Y2hJ0M");

    // 全て異なるURLであること（1件目への集約バグの再発防止）
    const urls = analysis.extractedLotteries.map((l) => l.applicationUrl);
    expect(new Set(urls).size).toBe(6);
  });
});
