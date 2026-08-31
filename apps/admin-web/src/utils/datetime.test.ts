import { describe, expect, it } from "vitest";
import { fromDatetimeLocalValue, isBareDateOnly, toDatetimeLocalValue } from "./datetime";

describe("toDatetimeLocalValue / fromDatetimeLocalValue", () => {
  it("nullは空文字を返す", () => {
    expect(toDatetimeLocalValue(null)).toBe("");
  });

  it("空文字はnullを返す", () => {
    expect(fromDatetimeLocalValue("")).toBeNull();
  });

  it("ISO文字列とdatetime-local値を相互変換できる（ローカルタイムゾーン基準）", () => {
    const iso = "2026-08-07T05:30:00.000Z";
    const localValue = toDatetimeLocalValue(iso);
    // 逆変換すると同じ瞬間（epoch ms）に戻ることを確認する（タイムゾーンに依存せず検証できる）
    const roundTripped = fromDatetimeLocalValue(localValue);
    expect(new Date(roundTripped!).getTime()).toBe(new Date(iso).getTime());
  });

  it("不正な形式はnullを返す", () => {
    expect(fromDatetimeLocalValue("not-a-date")).toBeNull();
  });

  it("時刻の無い日付のみの文字列（'YYYY-MM-DD'）は空文字を返す（実在しない時刻を捏造しない）", () => {
    expect(toDatetimeLocalValue("2026-09-06")).toBe("");
  });
});

describe("isBareDateOnly", () => {
  it("'YYYY-MM-DD'形式はtrue", () => {
    expect(isBareDateOnly("2026-09-06")).toBe(true);
  });

  it("時刻付きISO文字列はfalse", () => {
    expect(isBareDateOnly("2026-09-06T20:00:00+09:00")).toBe(false);
  });

  it("nullはfalse", () => {
    expect(isBareDateOnly(null)).toBe(false);
  });
});
