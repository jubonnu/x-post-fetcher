import { describe, it, expect } from "vitest";
import { mergeLotteryData } from "../src/services/mergeLotteryData.ts";

const existing = {
  normalizedProductName: "MEGAドリームex",
  normalizedStoreName: "ドラゴンスター",
  region: null,
  applicationUrl: null,
  applicationEndAt: null,
  applicationEndDate: null,
  applicationEndPrecision: "unknown",
  resultAnnouncementAt: null,
  resultAnnouncementDate: null,
  resultAnnouncementPrecision: "unknown",
  verificationStatus: "extracted",
};

describe("mergeLotteryData", () => {
  it("空欄補完: 既存が空・新規に値 → 採用 + updated 履歴", () => {
    const r = mergeLotteryData(existing, { ...existing, region: "関西" });
    expect(r.updates.region).toBe("関西");
    expect(r.hasConflict).toBe(false);
    expect(r.changes).toContainEqual({ fieldName: "region", oldValue: null, newValue: "関西", changeType: "updated" });
  });

  it("同値 → 変更なし", () => {
    const r = mergeLotteryData(existing, { ...existing });
    expect(r.changes).toHaveLength(0);
    expect(Object.keys(r.updates)).toHaveLength(0);
  });

  it("競合: 両方に異なる値 → 既存維持・conflicting・上書きしない", () => {
    const a = { ...existing, applicationUrl: "https://forms.gle/aaa" };
    const b = { ...existing, applicationUrl: "https://forms.gle/bbb" };
    const r = mergeLotteryData(a, b);
    expect(r.hasConflict).toBe(true);
    expect(r.verificationStatus).toBe("conflicting");
    expect(r.updates.applicationUrl).toBeUndefined(); // 上書きしない
    expect(r.changes).toContainEqual({
      fieldName: "applicationUrl",
      oldValue: "https://forms.gle/aaa",
      newValue: "https://forms.gle/bbb",
      changeType: "conflicting",
    });
  });

  it("日付: 空 → 補完（グループごと採用）", () => {
    const incoming = {
      ...existing,
      applicationEndDate: "2026-08-11",
      applicationEndAt: "2026-08-11T23:59:00+09:00",
      applicationEndPrecision: "datetime",
    };
    const r = mergeLotteryData(existing, incoming);
    expect(r.updates.applicationEndDate).toBe("2026-08-11");
    expect(r.updates.applicationEndPrecision).toBe("datetime");
  });

  it("日付: 高精度を低精度で上書きしない", () => {
    const existHigh = {
      ...existing,
      applicationEndDate: "2026-08-11",
      applicationEndAt: "2026-08-11T23:59:00+09:00",
      applicationEndPrecision: "datetime",
    };
    const incomingLow = { ...existing, applicationEndDate: "2026-08-11", applicationEndPrecision: "date_only" };
    const r = mergeLotteryData(existHigh, incomingLow);
    expect(r.updates.applicationEndDate).toBeUndefined(); // 上書きなし
    expect(r.hasConflict).toBe(false);
  });

  it("日付: 同精度で値が異なれば競合", () => {
    const a = { ...existing, applicationEndDate: "2026-08-11", applicationEndPrecision: "date_only" };
    const b = { ...existing, applicationEndDate: "2026-08-12", applicationEndPrecision: "date_only" };
    const r = mergeLotteryData(a, b);
    expect(r.hasConflict).toBe(true);
    expect(r.verificationStatus).toBe("conflicting");
  });
});
