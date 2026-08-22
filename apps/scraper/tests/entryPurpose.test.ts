import { describe, it, expect } from "vitest";
import { classifyEntryPurpose } from "../src/lottery/entryPurpose.ts";

describe("classifyEntryPurpose", () => {
  it("1. 「抽選開始」を含む → new_lottery", () => {
    expect(classifyEntryPurpose("イオンで「メガドリームex」の抽選開始されました")).toBe("new_lottery");
  });

  it("2. 「抽選告知」を含む → new_lottery", () => {
    expect(classifyEntryPurpose("イオンで「メガドリームex」の抽選告知されました")).toBe("new_lottery");
  });

  it("「抽選受付」を含む → new_lottery（2026-08実データで発見した表記揺れ対応）", () => {
    expect(classifyEntryPurpose("コナミスタイルで「ORIGINAL ARTWORK COLLECTION」の抽選受付が開始‼")).toBe("new_lottery");
  });

  it("「抽選」と「スタート」を両方含む → new_lottery（2026-08実データ「抽選企画がスタートしました」対応）", () => {
    expect(classifyEntryPurpose("コレクションムーンBOX抽選企画がスタートしました🔥")).toBe("new_lottery");
  });

  it("「スタート」単体では new_lottery 判定しない", () => {
    expect(classifyEntryPurpose("本日からトレカ情報の投稿時間をスタート時刻変更します")).toBe("ignored");
  });

  it("3. 「抽選まとめ」を含む → summary", () => {
    expect(classifyEntryPurpose("本日開始された抽選まとめ💁‍♂️\n✅ホビステ 8/12〆")).toBe("summary");
  });

  it("4. 「抽選中 全てまとめ」などスペース揺れ → summary", () => {
    expect(classifyEntryPurpose("週末なので抽選中　全てまとめておきました💁‍♂️")).toBe("summary");
    expect(classifyEntryPurpose("週末なので抽選中\n全てまとめておきました")).toBe("summary");
  });

  it("「抽選 まとめ」（全角/半角スペース挟み）→ summary", () => {
    expect(classifyEntryPurpose("本日告知or開始された抽選 まとめ💁‍♂️")).toBe("summary");
    expect(classifyEntryPurpose("本日告知or開始された抽選　まとめ💁‍♂️")).toBe("summary");
  });

  it("5. 「抽選結果発表」を含む → result", () => {
    expect(classifyEntryPurpose("世界最強の戦士 抽選結果発表日まとめました🎯")).toBe("result");
  });

  it("6. どのキーワードも無し → ignored", () => {
    expect(classifyEntryPurpose("8/1(土)トレカ情報まとめ ザビニュース📺\n✅メガレックウザex SAR 90,000円前後で取引中")).toBe(
      "ignored"
    );
  });

  it("空文字・null相当 → ignored", () => {
    expect(classifyEntryPurpose("")).toBe("ignored");
  });

  it("優先順位: result と summary の両方に該当する場合は result を優先する", () => {
    // 「抽選結果発表」と「抽選まとめ」を同時に含む合成テキスト
    expect(classifyEntryPurpose("抽選結果発表と抽選まとめを両方書いたテキスト")).toBe("result");
  });

  it("優先順位: summary と new_lottery の両方に該当する場合は summary を優先する", () => {
    expect(classifyEntryPurpose("抽選まとめ、および抽選開始のお知らせ")).toBe("summary");
  });

  it("実データ回帰: どのキーワードにも一致しない言い回しでも「抽選」＋締切マーカー「〆」が複数あれば summary（sourcePostId=261）", () => {
    // 「今週開始した抽選増えたのでまとめておきました」はSUMMARY_ENTRY_KEYWORDSのどれにも一致せず、
    // 20件近い抽選情報（✅店舗+日付〆+URL）が丸ごと抽出されずに失われていた。
    const body =
      "今週開始した抽選増えたのでまとめておきました💁‍♂️\n\n" +
      "【30th CELEBRATION】\n✅ヤマダ電機 8/19(水)23:59〆\nhttps://example.com\n\n" +
      "✅イオンスタイルオンライン 8/20(木)23:59〆\nhttps://example.com";
    expect(classifyEntryPurpose(body)).toBe("summary");
  });

  it("「抽選」を含んでいても締切マーカー「〆」が1件以下なら ignored のまま（価格ダイジェスト投稿の誤判定防止）", () => {
    // 「トレカ情報まとめ ザビニュース」形式の投稿は「抽選結果が発表される」等、稀に「抽選」を含むが
    // 締切〆は使わないため、summaryへ誤って昇格させない（2026-08、sourcePostId=263で確認）。
    const body =
      "8/21(金)トレカ情報まとめ ザビニュース📺\n\n" +
      "✅30th CELEBRATION関連 ポケセンオンラインで抽選結果が発表される‼️\n\n" +
      "✅メガダークライex SAR PSA10 57,000円台まで下がる\n\n" +
      "✅明日発売 世界最強の戦士 現在20,000円前後で取引中‼️";
    expect(classifyEntryPurpose(body)).toBe("ignored");
  });
});
