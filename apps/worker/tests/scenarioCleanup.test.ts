import { describe, expect, it } from "vitest";
import {
  assertOnlyTracked,
  createScenarioTracker,
  trackLotteryResults,
  trackSourcePost,
  trackedIdsAsDeletionTargets,
} from "../scripts/lib/scenarioCleanup.ts";

describe("scenarioCleanup", () => {
  it("trackSourcePost/trackLotteryResultsで作成したIDだけが追跡される", () => {
    const tracker = createScenarioTracker();
    trackSourcePost(tracker, 101);
    trackSourcePost(tracker, 102);
    trackLotteryResults(tracker, [
      { lotteryId: 5, candidateId: null },
      { lotteryId: null, candidateId: 9 },
      { lotteryId: null, candidateId: null }, // own_confirmed_skipped等、どちらも作らないケース
    ]);

    expect([...tracker.sourcePostIds].sort()).toEqual([101, 102]);
    expect([...tracker.lotteryIds]).toEqual([5]);
    expect([...tracker.candidateIds]).toEqual([9]);
  });

  it("assertOnlyTrackedは追跡済みIDのみの削除を許可する", () => {
    const tracked = new Set([1, 2, 3]);
    expect(() => assertOnlyTracked("lottery", [1, 2], tracked)).not.toThrow();
  });

  it("assertOnlyTrackedは追跡されていないIDが1つでも含まれれば例外を投げ、削除を拒否する", () => {
    // これが本来の回帰テスト: 過去のバグ（source_post_idの数値範囲で再スキャンして
    // 既存の無関係な行を巻き込んで削除してしまった）を、このガードが再発時に検知できることを確認する。
    const tracked = new Set([1, 2, 3]);
    const idsDerivedByUnsafeRescan = [1, 2, 3, 999]; // 999 = このテスト実行では作成していないはずのID
    expect(() => assertOnlyTracked("lottery", idsDerivedByUnsafeRescan, tracked)).toThrow(
      /refusing to delete untracked lottery ids: 999/
    );
  });

  it("trackedIdsAsDeletionTargetsは追跡済み集合をそのまま返す（再導出しない）", () => {
    const tracker = createScenarioTracker();
    trackLotteryResults(tracker, [{ lotteryId: 42, candidateId: null }]);
    expect(trackedIdsAsDeletionTargets(tracker.lotteryIds)).toEqual([42]);
  });

  it("空の結果を渡してもエラーにならない", () => {
    const tracker = createScenarioTracker();
    expect(() => trackLotteryResults(tracker, undefined)).not.toThrow();
    expect(() => trackLotteryResults(tracker, [])).not.toThrow();
    expect(tracker.lotteryIds.size).toBe(0);
  });
});
