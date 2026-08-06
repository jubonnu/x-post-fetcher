import type { LotteryStatus } from "./lotteryStatusTransitions.ts";

/**
 * 統計API（Mobile-G6）の集計単位。「1回の応募試行」を`user_lottery_status_history`から
 * 再構築したもの。運用チャットで確定した仕様（2026-08）に基づく:
 *
 * - 同一の抽選（lotteryId）でも、見送り後の再応募・訂正入力などにより複数回の応募試行が
 *   起こりうる。各試行を独立した1件として数える（lotteryId単位の重複排除ではない）。
 * - `result`は各試行で最初に到達したwon/lostのみを保持する（同一試行内で複数回
 *   won/lostへ遷移することは状態遷移ホワイトリスト上ない）。
 * - `purchaseState`はwon確定後の追加状態（購入済み/購入見送り）。`purchased→won`・
 *   `skipped→won`という「訂正」入力は新規試行を作らず、同一試行の`purchaseState`を
 *   リセットする（当選実績自体は消さない）。
 */
export interface LotteryAttempt {
  lotteryId: number;
  startedAt: string;
  result: "won" | "lost" | null;
  resultAt: string | null;
  purchaseState: "purchased" | "skipped" | null;
  purchaseAt: string | null;
}

export interface StatusHistoryEvent {
  lotteryId: number;
  fromStatus: LotteryStatus | null;
  toStatus: LotteryStatus;
  changedAt: string;
}

/**
 * `events`は発生順（`user_lottery_status_history.id`昇順。`changedAt`はサーバー生成のため
 * 同時刻でも`id`が実発生順を保持する）で渡すこと。複数の`lotteryId`が混在してもよい
 * （内部でグループ化してから独立に処理する）。
 *
 * 試行の開始・結果確定・購入状態の遷移ルール:
 * 1. `applied`への到達で新規試行を開始する。ただし既にオープン中の試行が未確定
 *    （`result === null`）のまま`applied`が再度記録された場合は、重複イベントとして無視する
 *    （冪等性・sync_merge由来の再送を想定）。
 * 2. オープン中の試行が無い状態で`won`/`lost`へ直接到達した場合（`unknown`からの過去分
 *    一括記録を想定した遷移）は、そのイベント自体を開始兼結果確定の1試行として扱う。
 *    オープン中の試行が無い状態で`purchased`へ直接到達した場合（`unknown→purchased`）も
 *    同様に1試行として扱うが、`purchased`は本来`won`を経由してのみ到達する状態のため、
 *    このイベント自体に**暗黙的なwon補完**を行う（`result: "won"`を同時に確定させる。
 *    過去分を「当選して購入済み」として一括記録する運用を想定）。
 * 3. `won`後の`purchased`/`skipped`は同一試行の追加状態（`purchaseState`）として扱う。
 * 4. `purchased→won`（訂正入力）は新規試行を作らず、`purchaseState`を`null`に戻す
 *    （当選実績＝`result`は変えない）。`skipped→won`も同様のロジックで処理できるが、
 *    現在の状態遷移ホワイトリスト（`lotteryStatusTransitions.ts`）は`skipped → planned`
 *    のみを許可しており、`skipped→won`は意図的に禁止している（`skipped`が「応募前の見送り」
 *    と「当選後の購入見送り」の2つの意味を持つ単一status設計のまま許可すると誤集計の
 *    余地があるため。将来`application`/`result`/`purchase`を別軸化する際の検討事項）。
 *    そのためこの分岐は現状の実データでは到達しないが、ホワイトリストが将来変更された
 *    場合に備えて防御的に残してある。
 * 5. 再度`applied`へ到達した場合は、直前の試行の結果確定状況に関わらず常に新規試行を開始する
 *    （直前の試行はその時点でクローズし、集計対象として確定する）。
 * 6. `applied`を経由せず`skipped`へ到達した場合（`unknown`/`planned`からの見送り）は、
 *    応募自体が行われていないため試行として数えない。
 */
export function reconstructAttempts(events: readonly StatusHistoryEvent[]): LotteryAttempt[] {
  const byLottery = new Map<number, StatusHistoryEvent[]>();
  for (const event of events) {
    const list = byLottery.get(event.lotteryId);
    if (list) list.push(event);
    else byLottery.set(event.lotteryId, [event]);
  }

  const attempts: LotteryAttempt[] = [];
  for (const [lotteryId, lotteryEvents] of byLottery) {
    attempts.push(...reconstructAttemptsForOneLottery(lotteryId, lotteryEvents));
  }
  return attempts;
}

function reconstructAttemptsForOneLottery(lotteryId: number, events: readonly StatusHistoryEvent[]): LotteryAttempt[] {
  const attempts: LotteryAttempt[] = [];
  let open: LotteryAttempt | null = null;

  const closeOpenAttempt = () => {
    if (open) attempts.push(open);
    open = null;
  };

  for (const event of events) {
    switch (event.toStatus) {
      case "applied": {
        if (open && open.result === null) break; // 同一試行内の重複appliedイベントは無視
        closeOpenAttempt();
        open = { lotteryId, startedAt: event.changedAt, result: null, resultAt: null, purchaseState: null, purchaseAt: null };
        break;
      }
      case "won":
      case "lost": {
        if (!open) {
          open = { lotteryId, startedAt: event.changedAt, result: event.toStatus, resultAt: event.changedAt, purchaseState: null, purchaseAt: null };
          break;
        }
        if (open.result === null) {
          open.result = event.toStatus;
          open.resultAt = event.changedAt;
          break;
        }
        // 既に結果確定済み: purchased/skippedからの「won」への訂正のみ、購入状態をリセットする
        if (event.toStatus === "won" && (event.fromStatus === "purchased" || event.fromStatus === "skipped")) {
          open.purchaseState = null;
          open.purchaseAt = null;
        }
        break;
      }
      case "purchased": {
        if (!open) {
          // unknownからの直接到達（過去分一括記録）。purchasedはwon経由でしか到達しないため、
          // このイベント自体に暗黙的なwon補完を行い、開始・当選・購入済みを1試行として確定する。
          open = { lotteryId, startedAt: event.changedAt, result: "won", resultAt: event.changedAt, purchaseState: "purchased", purchaseAt: event.changedAt };
          break;
        }
        open.purchaseState = "purchased";
        open.purchaseAt = event.changedAt;
        break;
      }
      case "skipped": {
        if (open && open.result !== null) {
          // 当選確定後の購入見送り
          open.purchaseState = "skipped";
          open.purchaseAt = event.changedAt;
        }
        // オープン中の試行が無い、または結果未確定の場合は「応募自体の見送り」であり、
        // 試行として数えない。
        break;
      }
      case "planned":
      case "unknown":
        break; // 試行の開始・結果に影響しない
    }
  }
  closeOpenAttempt();
  return attempts;
}

/** 分子: resultがwonの試行数。分母: resultがwon/lostのいずれかの試行数（分母0ならnull）。 */
export function computeWinRate(attempts: readonly LotteryAttempt[]): number | null {
  const won = attempts.filter((a) => a.result === "won").length;
  const lost = attempts.filter((a) => a.result === "lost").length;
  const decided = won + lost;
  return decided > 0 ? won / decided : null;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function toJstYearMonth(iso: string): string {
  const jst = new Date(new Date(iso).getTime() + JST_OFFSET_MS);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** `referenceIso`が属するJSTの月を起点に、遡って`months`件分の年月文字列を古い順で返す。 */
export function lastNMonthsJst(months: number, referenceIso: string): string[] {
  const jstRef = new Date(new Date(referenceIso).getTime() + JST_OFFSET_MS);
  const result: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(jstRef.getUTCFullYear(), jstRef.getUTCMonth() - i, 1));
    result.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return result;
}
