import { describe, it, expect } from "vitest";
import { resolveDate, resolveDateRange } from "../src/utils/date.ts";

const POST = "2026-07-24T04:00:00.000Z"; // JST 2026-07-24 13:00

describe("resolveDate", () => {
  it("#17 年省略 + 時刻あり → 投稿日から年推定・datetime（yearInferred）", () => {
    const r = resolveDate("8/11(火)23:59〆", POST);
    // 2026-08-11 は火曜日
    expect(r.at).toBe("2026-08-11T23:59:00+09:00");
    expect(r.date).toBe("2026-08-11");
    expect(r.precision).toBe("datetime");
    expect(r.status).toBe("extracted");
    expect(r.yearInferred).toBe(true);
  });

  it("#9 「閉店時間〆」→ store_closing_time（at は null、date のみ）", () => {
    const r = resolveDate("11/10 閉店時間〆", POST);
    expect(r.at).toBeNull();
    expect(r.date).toBe("2026-11-10");
    expect(r.precision).toBe("store_closing_time");
    expect(r.rawText).toBe("11/10 閉店時間〆");
  });

  it("#18 曜日と推定年が一致しない → conflicting", () => {
    // 2026-08-11 は火曜。ここで (水) を与えると不一致
    const r = resolveDate("8/11(水)23:59〆", POST);
    expect(r.status).toBe("conflicting");
    expect(r.yearInferred).toBe(true);
  });

  it("日付のみ → date_only", () => {
    const r = resolveDate("当選発表 8/15", POST);
    expect(r.at).toBeNull();
    expect(r.date).toBe("2026-08-15");
    expect(r.precision).toBe("date_only");
  });

  it("過去月は翌年に繰り越す（締切は未来）", () => {
    // 投稿 7/24 に対し 1/23 → 翌年 2027-01-23
    const r = resolveDate("1/23", POST);
    expect(r.date).toBe("2027-01-23");
    expect(r.yearInferred).toBe(true);
  });

  it("明示的な年は yearInferred=false", () => {
    const r = resolveDate("2025年2月7日", POST);
    expect(r.date).toBe("2025-02-07");
    expect(r.yearInferred).toBe(false);
  });

  it("日付表現なし → unknown", () => {
    const r = resolveDate("抽選開始されました", POST);
    expect(r.precision).toBe("unknown");
    expect(r.status).toBe("unknown");
  });

  it("漢字形式の時刻「14時」→ datetime（分省略は00分）", () => {
    const r = resolveDate("8月11日(火)14時", POST);
    expect(r.at).toBe("2026-08-11T14:00:00+09:00");
    expect(r.precision).toBe("datetime");
  });

  it("漢字形式の時刻「23時59分」→ datetime", () => {
    const r = resolveDate("8月13日(木)23時59分", POST);
    expect(r.at).toBe("2026-08-13T23:59:00+09:00");
    expect(r.precision).toBe("datetime");
  });

  it("「10時間」のような期間表現は時刻として誤認しない → date_only", () => {
    const r = resolveDate("8月11日から10時間限定", POST);
    expect(r.precision).toBe("date_only");
  });

  it("コロン形式が優先される（両方あれば「14:00」側を使う）", () => {
    const r = resolveDate("8月19日 14:00開始（14時から）", POST);
    expect(r.at).toBe("2026-08-19T14:00:00+09:00");
  });
});

describe("resolveDateRange", () => {
  it("「A〜B」形式の範囲を開始・終了それぞれ解決する", () => {
    const r = resolveDateRange("8月11日(火)14時〜8月13日(木)23時59分", POST);
    expect(r.start?.at).toBe("2026-08-11T14:00:00+09:00");
    expect(r.end.at).toBe("2026-08-13T23:59:00+09:00");
  });

  it("全角チルダ（～）区切りにも対応する", () => {
    const r = resolveDateRange("8月19日(水)～8月26日(水)", POST);
    expect(r.start?.date).toBe("2026-08-19");
    expect(r.end.date).toBe("2026-08-26");
  });

  it("半角チルダ（~）区切りにも対応する", () => {
    const r = resolveDateRange("8月19日~8月26日", POST);
    expect(r.start?.date).toBe("2026-08-19");
    expect(r.end.date).toBe("2026-08-26");
  });

  it("区切りが無い単一日付は resolveDate と同じ結果を end に返し、start は null", () => {
    const r = resolveDateRange("8/11(火)23:59〆", POST);
    expect(r.start).toBeNull();
    expect(r.end.at).toBe("2026-08-11T23:59:00+09:00");
  });

  it("区切り記号はあるが終了側に日付が無い文章（誤検知防止）→ 単一日付としてend側のみ解決を試みる", () => {
    const r = resolveDateRange("8月19日〜大変お得なキャンペーンです", POST);
    expect(r.start).toBeNull();
    // 全体を単一日付として再解決した結果（8/19が拾える）
    expect(r.end.date).toBe("2026-08-19");
  });

  it("開始側に日付が無い場合は終了日のみ確定させる（startはnull）", () => {
    const r = resolveDateRange("いつでも〜8月14日(金)23時59分まで", POST);
    expect(r.start).toBeNull();
    expect(r.end.date).toBe("2026-08-14");
  });

  it("空文字/nullはend側もunknown・startはnull", () => {
    expect(resolveDateRange("", POST)).toEqual({ start: null, end: resolveDate("", POST) });
    expect(resolveDateRange(null, POST).start).toBeNull();
  });
});
