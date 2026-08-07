import { describe, expect, it } from "vitest";
import { fromDatetimeLocalValue, toDatetimeLocalValue } from "./datetime";

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
});
