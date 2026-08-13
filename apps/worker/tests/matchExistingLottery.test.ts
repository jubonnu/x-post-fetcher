import { describe, it, expect } from "vitest";
import {
  hardBlockReason,
  matchExistingLottery,
  scorePair,
  type MatchableLottery,
} from "../src/services/matchExistingLottery.ts";

const base: MatchableLottery = {
  cardType: "pokemon",
  normalizedProductName: "MEGAドリームex",
  normalizedStoreName: "ドラゴンスター",
  normalizedStoreBranch: null,
  region: null,
  applicationEndAt: "2026-08-11T23:59:00+09:00",
  applicationEndDate: "2026-08-11",
  applicationEndPrecision: "datetime",
  applicationUrl: null,
};

describe("hardBlockReason（禁止条件）", () => {
  it("カード種類が異なる → block", () => {
    expect(hardBlockReason(base, { ...base, cardType: "onepiece" })).toBe("card_type_differs");
  });
  it("支店が異なる → block", () => {
    const a = { ...base, normalizedStoreBranch: "梅田店" };
    const b = { ...base, normalizedStoreBranch: "難波店" };
    expect(hardBlockReason(a, b)).toBe("store_branch_differs");
  });
  it("締切差が閾値(7日)超 → block", () => {
    const b = { ...base, applicationEndDate: "2026-08-20", applicationEndAt: "2026-08-20T23:59:00+09:00" };
    expect(hardBlockReason(base, b)).toBe("deadline_diff_gt_7d");
  });
  it("締切が未確定(not_published)なら締切差でブロックしない", () => {
    const b = { ...base, applicationEndDate: null, applicationEndPrecision: "not_published" };
    expect(hardBlockReason(base, b)).toBeNull();
  });
  it("同一なら block なし", () => {
    expect(hardBlockReason(base, { ...base })).toBeNull();
  });
});

describe("scorePair（スコアリング）", () => {
  it("商品・店舗・締切一致 → 85", () => {
    expect(scorePair(base, { ...base })).toBe(85); // 40 + 30 + 15
  });
  it("商品一致・店舗違い・締切同じ → 55（商品40+締切15）", () => {
    expect(scorePair(base, { ...base, normalizedStoreName: "ホビーステーション" })).toBe(55);
  });
  it("締切1日差 → 締切は8点", () => {
    const b = { ...base, applicationEndDate: "2026-08-12", applicationEndAt: "2026-08-12T23:59:00+09:00" };
    expect(scorePair(base, b)).toBe(78); // 40 + 30 + 8
  });

  it("結果待ちボーナス: 商品店舗一致(締切なし)＋候補に当選発表あり＋既存に無し → +15で85", () => {
    const noDeadline = { ...base, applicationEndDate: null, applicationEndPrecision: "unknown" };
    const candidate = { ...noDeadline, resultAnnouncementDate: "2026-08-15" };
    const existing = { ...noDeadline, resultAnnouncementDate: null };
    expect(scorePair(candidate, existing)).toBe(85); // 40 + 30 + 15
  });

  it("結果待ちボーナス: 既存側に既に当選発表情報があれば加点しない", () => {
    const noDeadline = { ...base, applicationEndDate: null, applicationEndPrecision: "unknown" };
    const candidate = { ...noDeadline, resultAnnouncementDate: "2026-08-15" };
    const existing = { ...noDeadline, resultAnnouncementDate: "2026-08-15" };
    expect(scorePair(candidate, existing)).toBe(70); // 40 + 30、ボーナスなし
  });

  it("結果待ちボーナス: 商品・店舗どちらも一致しなければ加点しない（誤統合防止）", () => {
    const noMatch = {
      ...base,
      normalizedProductName: "別商品",
      normalizedStoreName: "別店舗",
      applicationEndDate: null,
      applicationEndPrecision: "unknown",
    };
    const candidate = { ...noMatch, resultAnnouncementDate: "2026-08-15" };
    const existing = { ...base, applicationEndDate: null, applicationEndPrecision: "unknown", resultAnnouncementDate: null };
    expect(scorePair(candidate, existing)).toBe(0);
  });
});

describe("matchExistingLottery（判定）", () => {
  it("既存なし → new", () => {
    expect(matchExistingLottery(base, []).action).toBe("new");
  });
  it("完全一致(85) → merge", () => {
    const r = matchExistingLottery(base, [{ ...base }]);
    expect(r.action).toBe("merge");
    expect(r.matchedIndex).toBe(0);
    expect(r.score).toBe(85);
  });
  it("締切なしで商品店舗一致(70) → review", () => {
    const noDeadline = { ...base, applicationEndDate: null, applicationEndPrecision: "unknown" };
    const r = matchExistingLottery(noDeadline, [{ ...noDeadline }]);
    expect(r.score).toBe(70); // 40 + 30
    expect(r.action).toBe("review");
  });
  it("商品のみ一致・締切なし(40) → new", () => {
    // 締切を除外することで商品スコア40のみ → new(<50)
    const noDeadline = { ...base, applicationEndDate: null, applicationEndPrecision: "unknown" };
    const r = matchExistingLottery(noDeadline, [{ ...noDeadline, normalizedStoreName: "ホビステ" }]);
    expect(r.action).toBe("new");
    expect(r.score).toBe(40);
  });
  it("高スコアでも禁止条件該当なら new（block）", () => {
    const blocked = { ...base, cardType: "onepiece" }; // 商品店舗締切は一致だが card 違い
    const r = matchExistingLottery(base, [blocked]);
    expect(r.action).toBe("new");
    expect(r.reason).toContain("card_type_differs");
  });
  it("複数候補から最高スコアを選ぶ", () => {
    const weak = { ...base, normalizedStoreName: "別店", applicationEndDate: null, applicationEndPrecision: "unknown" };
    const strong = { ...base };
    const r = matchExistingLottery(base, [weak, strong]);
    expect(r.matchedIndex).toBe(1);
    expect(r.action).toBe("merge");
  });

  it("当選発表だけの短い後続投稿（締切再掲なし）でも商品・店舗が一致していれば自動マージされる", () => {
    // 既存: 応募締切は確定済みだが当選発表はまだ無い（応募受付中の状態）
    const existingAwaitingResult = { ...base, resultAnnouncementDate: null };
    // 候補: 「当選発表しました」のような短い投稿。締切は再掲されないため applicationEndDate は無い。
    const resultAnnouncementCandidate = {
      ...base,
      applicationEndAt: null,
      applicationEndDate: null,
      applicationEndPrecision: "unknown",
      resultAnnouncementDate: "2026-08-15",
    };
    const r = matchExistingLottery(resultAnnouncementCandidate, [existingAwaitingResult]);
    expect(r.action).toBe("merge"); // 40(商品) + 30(店舗) + 15(結果待ちボーナス) = 85
    expect(r.score).toBe(85);
  });
});
