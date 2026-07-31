/**
 * `toEventTimestamp`が生成する文字列は、Webhookイベント順序逆転ガード
 * （`revenuecatWebhookProcessor.ts`の`applyVerifiedEntitlement`）が辞書式文字列比較で
 * 時系列順序を判定できることの前提となっている。この前提（UTC固定形式）が崩れないことを
 * 固定するテスト。
 */
import { describe, expect, it } from "vitest";
import { toEventTimestamp } from "../src/services/revenuecatWebhookProcessor.ts";

const ISO_UTC_FIXED_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("toEventTimestamp", () => {
  it("event_timestamp_msから常にUTC固定形式（YYYY-MM-DDTHH:mm:ss.sssZ）を生成する", () => {
    expect(toEventTimestamp(1_735_689_600_000)).toMatch(ISO_UTC_FIXED_FORMAT);
  });

  it("event_timestamp_ms未指定（undefined/null）時も現在時刻をUTC固定形式で生成する", () => {
    expect(toEventTimestamp(undefined)).toMatch(ISO_UTC_FIXED_FORMAT);
    expect(toEventTimestamp(null)).toMatch(ISO_UTC_FIXED_FORMAT);
  });

  it("数値としての時系列順序と、生成された文字列の辞書式順序が一致する（順序逆転ガードの前提）", () => {
    const earlier = toEventTimestamp(1_700_000_000_000);
    const later = toEventTimestamp(1_700_000_000_001); // 1ミリ秒後
    expect(later > earlier).toBe(true);
    expect(earlier > later).toBe(false);
  });

  it("年・月をまたぐ境界でも辞書式順序が時系列順序と一致する", () => {
    const endOfYear = toEventTimestamp(Date.UTC(2025, 11, 31, 23, 59, 59, 999));
    const startOfNextYear = toEventTimestamp(Date.UTC(2026, 0, 1, 0, 0, 0, 0));
    expect(startOfNextYear > endOfYear).toBe(true);
  });

  it("2桁未満になりうる月・日・時・分・秒も常にゼロ埋めされる（桁数のブレによる比較ミスを防ぐ）", () => {
    const earlyMoment = toEventTimestamp(Date.UTC(2026, 0, 1, 1, 2, 3, 4)); // 2026-01-01T01:02:03.004Z
    expect(earlyMoment).toBe("2026-01-01T01:02:03.004Z");
  });

  it("同一ミリ秒値からは常に同じ文字列を生成する（冪等）", () => {
    const ms = 1_700_000_000_123;
    expect(toEventTimestamp(ms)).toBe(toEventTimestamp(ms));
  });
});
