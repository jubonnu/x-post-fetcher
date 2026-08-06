/**
 * Mobile-G6統計の再設計（2026-08）: 応募試行（application attempt）の再構築ロジックの単体テスト。
 * `user_lottery_status_history`を経由しない、`services/lotteryAttempts.ts`単体のテスト
 * （実APIのステータス遷移ホワイトリスト上は届きえない入力パターン——例: 同一statusの
 * 重複イベント——も含めて、再構築関数自体の頑健性を検証する）。
 */
import { describe, expect, it } from "vitest";
import { computeWinRate, reconstructAttempts, type StatusHistoryEvent } from "../src/services/lotteryAttempts.ts";
import type { LotteryStatus } from "../src/services/lotteryStatusTransitions.ts";

const LOTTERY_ID = 1;

function ev(fromStatus: LotteryStatus | null, toStatus: LotteryStatus, changedAt: string): StatusHistoryEvent {
  return { lotteryId: LOTTERY_ID, fromStatus, toStatus, changedAt };
}

describe("reconstructAttempts", () => {
  it("unknownのみ: 試行として数えない", () => {
    const attempts = reconstructAttempts([ev(null, "unknown", "2026-08-01T00:00:00.000Z")]);
    expect(attempts).toHaveLength(0);
  });

  it("unknown→won: 開始兼結果確定の1試行として扱う", () => {
    const attempts = reconstructAttempts([ev("unknown", "won", "2026-08-01T00:00:00.000Z")]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ result: "won", resultAt: "2026-08-01T00:00:00.000Z", startedAt: "2026-08-01T00:00:00.000Z" });
  });

  it("unknown→lost: 開始兼結果確定の1試行として扱う", () => {
    const attempts = reconstructAttempts([ev("unknown", "lost", "2026-08-01T00:00:00.000Z")]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ result: "lost", resultAt: "2026-08-01T00:00:00.000Z" });
  });

  it("applied→won", () => {
    const attempts = reconstructAttempts([ev("unknown", "applied", "2026-08-01T00:00:00.000Z"), ev("applied", "won", "2026-08-02T00:00:00.000Z")]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      startedAt: "2026-08-01T00:00:00.000Z",
      result: "won",
      resultAt: "2026-08-02T00:00:00.000Z",
      purchaseState: null,
    });
  });

  it("unknown→purchased: 過去分一括記録のための暗黙的なwon補完（開始・当選・購入済みを1イベントで確定）", () => {
    const attempts = reconstructAttempts([ev("unknown", "purchased", "2026-08-01T00:00:00.000Z")]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      startedAt: "2026-08-01T00:00:00.000Z",
      result: "won",
      resultAt: "2026-08-01T00:00:00.000Z",
      purchaseState: "purchased",
      purchaseAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("applied→lost", () => {
    const attempts = reconstructAttempts([ev("unknown", "applied", "2026-08-01T00:00:00.000Z"), ev("applied", "lost", "2026-08-02T00:00:00.000Z")]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ result: "lost", resultAt: "2026-08-02T00:00:00.000Z" });
  });

  it("applied→won→purchased: 当選1・購入済み", () => {
    const attempts = reconstructAttempts([
      ev("unknown", "applied", "2026-08-01T00:00:00.000Z"),
      ev("applied", "won", "2026-08-02T00:00:00.000Z"),
      ev("won", "purchased", "2026-08-03T00:00:00.000Z"),
    ]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ result: "won", purchaseState: "purchased", purchaseAt: "2026-08-03T00:00:00.000Z" });
  });

  it("applied→won→purchased→won: 訂正入力で購入状態のみリセット（当選実績は残る）", () => {
    const attempts = reconstructAttempts([
      ev("unknown", "applied", "2026-08-01T00:00:00.000Z"),
      ev("applied", "won", "2026-08-02T00:00:00.000Z"),
      ev("won", "purchased", "2026-08-03T00:00:00.000Z"),
      ev("purchased", "won", "2026-08-04T00:00:00.000Z"),
    ]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ result: "won", resultAt: "2026-08-02T00:00:00.000Z", purchaseState: null, purchaseAt: null });
  });

  it("applied→won→skipped: 当選1・購入見送り", () => {
    const attempts = reconstructAttempts([
      ev("unknown", "applied", "2026-08-01T00:00:00.000Z"),
      ev("applied", "won", "2026-08-02T00:00:00.000Z"),
      ev("won", "skipped", "2026-08-03T00:00:00.000Z"),
    ]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ result: "won", purchaseState: "skipped", purchaseAt: "2026-08-03T00:00:00.000Z" });
  });

  // 現在の状態遷移ホワイトリストでは`skipped→won`は許可されておらず、実APIでは発生しない
  // （`skipped`が「応募前の見送り」「当選後の購入見送り」の2意味を持つ単一status設計のまま
  // 許可すると誤集計の余地があるため、意図的に禁止——`lotteryStatusTransitions.ts`参照）。
  // ここでは`purchased→won`と対称的な訂正として、集計関数側の防御的な挙動のみ検証する。
  it("applied→won→skipped→won: 訂正入力で購入見送り状態のみリセット（当選実績は残る、APIでは未到達の防御的ケース）", () => {
    const attempts = reconstructAttempts([
      ev("unknown", "applied", "2026-08-01T00:00:00.000Z"),
      ev("applied", "won", "2026-08-02T00:00:00.000Z"),
      ev("won", "skipped", "2026-08-03T00:00:00.000Z"),
      ev("skipped", "won", "2026-08-04T00:00:00.000Z"),
    ]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ result: "won", resultAt: "2026-08-02T00:00:00.000Z", purchaseState: null, purchaseAt: null });
  });

  it("applied→won→skipped→planned→applied→lost: 2試行（1試行目won、2試行目lost）として数える", () => {
    const attempts = reconstructAttempts([
      ev("unknown", "applied", "2026-08-01T00:00:00.000Z"),
      ev("applied", "won", "2026-08-02T00:00:00.000Z"),
      ev("won", "skipped", "2026-08-03T00:00:00.000Z"),
      ev("skipped", "planned", "2026-08-04T00:00:00.000Z"),
      ev("planned", "applied", "2026-08-05T00:00:00.000Z"),
      ev("applied", "lost", "2026-08-06T00:00:00.000Z"),
    ]);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ result: "won", purchaseState: "skipped" });
    expect(attempts[1]).toMatchObject({ startedAt: "2026-08-05T00:00:00.000Z", result: "lost", resultAt: "2026-08-06T00:00:00.000Z" });
    expect(computeWinRate(attempts)).toBeCloseTo(0.5);
  });

  it("同一statusの重複イベント: appliedの重複は無視し、1試行として扱う", () => {
    const attempts = reconstructAttempts([
      ev("unknown", "applied", "2026-08-01T00:00:00.000Z"),
      ev("applied", "applied", "2026-08-01T12:00:00.000Z"), // sync_merge等による重複再送を想定
      ev("applied", "won", "2026-08-02T00:00:00.000Z"),
    ]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ startedAt: "2026-08-01T00:00:00.000Z", result: "won" });
  });

  it("同一statusの重複イベント: 結果確定後のwonの重複（訂正ではない）は購入状態に影響しない", () => {
    const attempts = reconstructAttempts([
      ev("unknown", "applied", "2026-08-01T00:00:00.000Z"),
      ev("applied", "won", "2026-08-02T00:00:00.000Z"),
      ev("won", "won", "2026-08-02T00:00:01.000Z"), // 同一状態への冪等な再送
    ]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ result: "won", purchaseState: null });
  });

  it("changedAt同一時でも、渡された配列順（id昇順相当）で安定して処理する", () => {
    const sameInstant = "2026-08-01T00:00:00.000Z";
    const attempts = reconstructAttempts([ev("unknown", "applied", sameInstant), ev("applied", "won", sameInstant)]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ result: "won" });
  });

  it("planned到達のみ（appliedに未到達）は試行として数えない", () => {
    const attempts = reconstructAttempts([ev("unknown", "planned", "2026-08-01T00:00:00.000Z")]);
    expect(attempts).toHaveLength(0);
  });

  it("unknown/plannedからのskippedは、応募自体の見送りであり試行として数えない", () => {
    const attempts = reconstructAttempts([
      ev("unknown", "planned", "2026-08-01T00:00:00.000Z"),
      ev("planned", "skipped", "2026-08-02T00:00:00.000Z"),
    ]);
    expect(attempts).toHaveLength(0);
  });

  it("結果未確定（appliedのまま）の試行は応募数には含むが、当選率の計算には含まれない", () => {
    const attempts = reconstructAttempts([ev("unknown", "applied", "2026-08-01T00:00:00.000Z")]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].result).toBeNull();
    expect(computeWinRate(attempts)).toBeNull();
  });
});

describe("computeWinRate", () => {
  it("結果が1件も無い場合はnull", () => {
    expect(computeWinRate([])).toBeNull();
  });

  it("won/lostの件数から算出する（複数lotteryIdをまたいで集計できる）", () => {
    const other: StatusHistoryEvent = { lotteryId: 2, fromStatus: "unknown", toStatus: "lost", changedAt: "2026-08-02T00:00:00.000Z" };
    const combined = reconstructAttempts([ev("unknown", "won", "2026-08-01T00:00:00.000Z"), other]);
    expect(combined).toHaveLength(2);
    expect(computeWinRate(combined)).toBeCloseTo(0.5);
  });
});
