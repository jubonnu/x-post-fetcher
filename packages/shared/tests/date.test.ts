import { describe, it, expect } from "vitest";
import { resolveDate } from "../src/utils/date.ts";

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
});
