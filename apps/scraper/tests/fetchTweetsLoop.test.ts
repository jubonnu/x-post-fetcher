import { describe, it, expect } from "vitest";
import { decideLoopIteration, type LoopIterationInput } from "../src/scraping/x/fetchTweets.ts";

const BASE: LoopIterationInput = {
  isDiffMode: false,
  collectedSize: 0,
  consecutiveKnownStreak: 0,
  boundaryExtraScrollsRemaining: null,
  totalValidSeenBefore: 0,
  totalValidSeenAfter: 0,
  noGrowth: 0,
  maxNewPostsPerRun: 200,
  initialTargetCount: 14,
  cursorReached: true,
};

describe("decideLoopIteration", () => {
  describe("初回モード", () => {
    it("目標件数未満なら継続", () => {
      const d = decideLoopIteration({ ...BASE, collectedSize: 10, totalValidSeenAfter: 10 });
      expect(d.stop).toBe(false);
    });

    it("目標件数に到達したら initial_run_target_reached で停止", () => {
      const d = decideLoopIteration({ ...BASE, collectedSize: 14, totalValidSeenAfter: 14 });
      expect(d.stop).toBe(true);
      expect(d.stopReason).toBe("initial_run_target_reached");
      expect(d.hitSafetyCap).toBe(false);
    });

    it("シナリオ2: 新規20件見つかっても目標14件到達時点で止まる（切り詰めは呼び出し側のslice）", () => {
      // 目標14に対し一度に20件見つかった場合でも判定自体は「到達」を返す
      const d = decideLoopIteration({ ...BASE, collectedSize: 20, totalValidSeenAfter: 20 });
      expect(d.stop).toBe(true);
      expect(d.stopReason).toBe("initial_run_target_reached");
    });
  });

  describe("差分モード: 安全上限", () => {
    it("新規投稿が安全上限に到達したら max_new_posts_per_run_reached で停止し hitSafetyCap=true", () => {
      const d = decideLoopIteration({
        ...BASE,
        isDiffMode: true,
        collectedSize: 200,
        totalValidSeenAfter: 200,
        maxNewPostsPerRun: 200,
      });
      expect(d.stop).toBe(true);
      expect(d.stopReason).toBe("max_new_posts_per_run_reached");
      expect(d.hitSafetyCap).toBe(true);
    });

    it("シナリオ2: 差分モードで新規20件は安全上限(200)未満なら切り詰めず継続", () => {
      const d = decideLoopIteration({ ...BASE, isDiffMode: true, collectedSize: 20, totalValidSeenAfter: 20 });
      expect(d.stop).toBe(false);
    });
  });

  describe("差分モード: 連続既知（境界検出）", () => {
    it("streakが閾値(4)未満なら継続", () => {
      const d = decideLoopIteration({ ...BASE, isDiffMode: true, consecutiveKnownStreak: 3, totalValidSeenAfter: 3 });
      expect(d.stop).toBe(false);
      expect(d.boundaryExtraScrollsRemaining).toBeNull();
    });

    it("streakが閾値(4)に達したら即停止せず、安全マージン(2回)のカウントダウンを開始する", () => {
      const d = decideLoopIteration({ ...BASE, isDiffMode: true, consecutiveKnownStreak: 4, totalValidSeenAfter: 4 });
      expect(d.stop).toBe(false); // 見つけた瞬間には終了しない
      expect(d.boundaryExtraScrollsRemaining).toBe(2);
    });

    it("安全マージンのスクロールで新規投稿が見つかればstreakがリセットされ境界検出をやり直す", () => {
      const afterBoundary = decideLoopIteration({ ...BASE, isDiffMode: true, consecutiveKnownStreak: 4, totalValidSeenAfter: 4 });
      // 次のスクロールで新規投稿1件見つかった（streakは呼び出し元でリセットされる想定）
      const d2 = decideLoopIteration({
        ...BASE,
        isDiffMode: true,
        collectedSize: 1,
        consecutiveKnownStreak: 0,
        boundaryExtraScrollsRemaining: afterBoundary.boundaryExtraScrollsRemaining,
        totalValidSeenBefore: 4,
        totalValidSeenAfter: 5,
      });
      // 境界カウントダウン中でも streak==0（新規発見）は「そのまま」進行する仕様のため、
      // カウントダウンは進むが新規投稿自体は取りこぼさない
      expect(d2.stop).toBe(false);
    });

    it("安全マージン2回のスクロールを経て known_streak_boundary_with_margin で停止する", () => {
      const r1 = decideLoopIteration({ ...BASE, isDiffMode: true, consecutiveKnownStreak: 4, totalValidSeenAfter: 4 });
      expect(r1.boundaryExtraScrollsRemaining).toBe(2);

      const r2 = decideLoopIteration({
        ...BASE,
        isDiffMode: true,
        consecutiveKnownStreak: 5,
        boundaryExtraScrollsRemaining: r1.boundaryExtraScrollsRemaining,
        totalValidSeenBefore: 4,
        totalValidSeenAfter: 5,
      });
      expect(r2.stop).toBe(false);
      expect(r2.boundaryExtraScrollsRemaining).toBe(1);

      const r3 = decideLoopIteration({
        ...BASE,
        isDiffMode: true,
        consecutiveKnownStreak: 6,
        boundaryExtraScrollsRemaining: r2.boundaryExtraScrollsRemaining,
        totalValidSeenBefore: 5,
        totalValidSeenAfter: 6,
      });
      expect(r3.stop).toBe(true);
      expect(r3.stopReason).toBe("known_streak_boundary_with_margin");
      expect(r3.hitSafetyCap).toBe(false);
    });
  });

  describe("recovery cursor未到達（cursorReached=false）", () => {
    it("streakが閾値(4)を超えていても境界検出しない（cursor未到達のため）", () => {
      const d = decideLoopIteration({ ...BASE, isDiffMode: true, consecutiveKnownStreak: 10, totalValidSeenAfter: 10, cursorReached: false });
      expect(d.stop).toBe(false);
      expect(d.boundaryExtraScrollsRemaining).toBeNull();
    });

    it("cursorReachedがtrueに切り替わった以降のイテレーションから境界検出が有効になる", () => {
      // cursor未到達の間はstreakが伸びても無視される
      const d1 = decideLoopIteration({ ...BASE, isDiffMode: true, consecutiveKnownStreak: 5, totalValidSeenAfter: 5, cursorReached: false });
      expect(d1.boundaryExtraScrollsRemaining).toBeNull();

      // cursorに到達した回から通常どおり境界検出が始まる
      const d2 = decideLoopIteration({
        ...BASE,
        isDiffMode: true,
        consecutiveKnownStreak: 4,
        boundaryExtraScrollsRemaining: d1.boundaryExtraScrollsRemaining,
        totalValidSeenBefore: 5,
        totalValidSeenAfter: 9,
        cursorReached: true,
      });
      expect(d2.boundaryExtraScrollsRemaining).toBe(2);
    });

    it("安全上限は cursorReached に関係なく優先される", () => {
      const d = decideLoopIteration({
        ...BASE,
        isDiffMode: true,
        collectedSize: 200,
        totalValidSeenAfter: 200,
        maxNewPostsPerRun: 200,
        cursorReached: false,
      });
      expect(d.stop).toBe(true);
      expect(d.stopReason).toBe("max_new_posts_per_run_reached");
      expect(d.hitSafetyCap).toBe(true);
    });
  });

  describe("stall検知（共通）", () => {
    it("有効投稿の総発見数が増えなければ1回目はnoGrowthを増やして継続", () => {
      const d = decideLoopIteration({ ...BASE, totalValidSeenBefore: 5, totalValidSeenAfter: 5, noGrowth: 0 });
      expect(d.stop).toBe(false);
      expect(d.noGrowth).toBe(1);
    });

    it("シナリオ3: 新規0件が3回連続で続いたら stall_no_dom_growth で停止する", () => {
      const d1 = decideLoopIteration({ ...BASE, totalValidSeenBefore: 5, totalValidSeenAfter: 5, noGrowth: 0 });
      const d2 = decideLoopIteration({ ...BASE, totalValidSeenBefore: 5, totalValidSeenAfter: 5, noGrowth: d1.noGrowth });
      const d3 = decideLoopIteration({ ...BASE, totalValidSeenBefore: 5, totalValidSeenAfter: 5, noGrowth: d2.noGrowth });
      expect(d1.stop).toBe(false);
      expect(d2.stop).toBe(false);
      expect(d3.stop).toBe(true);
      expect(d3.stopReason).toBe("stall_no_dom_growth");
    });

    it("増加すれば noGrowth は 0 にリセットされる", () => {
      const d = decideLoopIteration({ ...BASE, totalValidSeenBefore: 5, totalValidSeenAfter: 8, noGrowth: 2 });
      expect(d.noGrowth).toBe(0);
      expect(d.stop).toBe(false);
    });

    it("差分モードで既知投稿だけが続く（addedは増えないがknownは増える）場合はstall扱いしない", () => {
      // totalValidSeen は added+known の累計なので、known だけが増えても stall にはならない
      const d = decideLoopIteration({ ...BASE, isDiffMode: true, totalValidSeenBefore: 5, totalValidSeenAfter: 8, noGrowth: 2 });
      expect(d.stop).toBe(false);
      expect(d.noGrowth).toBe(0);
    });
  });
});
