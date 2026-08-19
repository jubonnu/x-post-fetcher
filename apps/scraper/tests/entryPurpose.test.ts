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
});
