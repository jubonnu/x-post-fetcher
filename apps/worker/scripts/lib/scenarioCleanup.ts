/**
 * ステージング検証スクリプト（`scripts/verifyLotteryUpdateCandidateScenarios.ts`）専用の
 * 「このテスト実行で実際に作成したIDだけを削除する」ための純粋関数群。
 *
 * 背景: 過去に一度、cleanup処理が`source_post_id`の数値範囲（作成したsource_postの
 * IDリストに一致するかどうか）で`lotteries`テーブルを再スキャンして削除対象を決めていたところ、
 * ステージングDBの既存モックデータ（`source_posts`が0件のため`lotteries.source_post_id`が
 * 実体の無い古いID値を指したまま残っていた）とID範囲が偶然衝突し、既存の1件を誤削除した。
 *
 * この教訓から、削除対象は「`persistAnalysis`の戻り値から直接収集したID」のみとし、
 * 外部キーでの再スキャン・数値範囲での絞り込みを一切行わない設計にする。
 * `assertOnlyTracked`は、将来再び「再スキャンでの削除」に戻ってしまうことを防ぐための
 * 実行時ガードであり、意図的にテスト対象として独立させている。
 */

export interface ScenarioTracker {
  sourcePostIds: Set<number>;
  lotteryIds: Set<number>;
  candidateIds: Set<number>;
}

export function createScenarioTracker(): ScenarioTracker {
  return { sourcePostIds: new Set(), lotteryIds: new Set(), candidateIds: new Set() };
}

export function trackSourcePost(tracker: ScenarioTracker, id: number): void {
  tracker.sourcePostIds.add(id);
}

export interface TrackableLotteryResult {
  lotteryId: number | null;
  candidateId: number | null;
}

/** `persistAnalysis`/`syncLotteriesFromAnalysis`の結果から、実際に作成・更新された行のIDだけを追跡する。 */
export function trackLotteryResults(tracker: ScenarioTracker, results: TrackableLotteryResult[] | undefined): void {
  for (const r of results ?? []) {
    if (r.lotteryId !== null) tracker.lotteryIds.add(r.lotteryId);
    if (r.candidateId !== null) tracker.candidateIds.add(r.candidateId);
  }
}

/**
 * 削除しようとしているID群が、このテスト実行で実際にトラッキングされたID集合の部分集合で
 * あることを保証する安全弁。`idsToDelete`が`trackedIds`に含まれない値を1つでも持つ場合、
 * 削除を実行せず例外を投げる（DB操作の直前に必ず呼ぶこと）。
 */
export function assertOnlyTracked(label: string, idsToDelete: number[], trackedIds: ReadonlySet<number>): void {
  const untracked = idsToDelete.filter((id) => !trackedIds.has(id));
  if (untracked.length > 0) {
    throw new Error(`[scenarioCleanup] refusing to delete untracked ${label} ids: ${untracked.join(", ")}`);
  }
}

/** 削除対象IDを確定させる（＝トラッキング済み集合をそのまま返す）ヘルパー。再スキャンは行わない。 */
export function trackedIdsAsDeletionTargets(trackedIds: ReadonlySet<number>): number[] {
  return [...trackedIds];
}
