/**
 * user_lotteries.status の状態遷移ホワイトリスト（Mobile-G2B-2）。
 * docs/mobile-g1-...20章 10.2節の遷移図をコード化する。サーバー側APIのみが正であり、
 * ここに無い遷移は422 VALIDATION_ERRORで拒否する（クライアント時計やUI操作に関わらず、
 * 不正な状態遷移を構造的に防ぐ）。
 */
export const LOTTERY_STATUSES = [
  "unknown",
  "planned",
  "applied",
  "won",
  "lost",
  "purchased",
  "skipped",
] as const;

export type LotteryStatus = (typeof LOTTERY_STATUSES)[number];

export function isLotteryStatus(value: string): value is LotteryStatus {
  return (LOTTERY_STATUSES as readonly string[]).includes(value);
}

/**
 * `unknown`からは任意の状態へ直接遷移可（過去分の一括記録を許容、10.2節）。
 * `won → purchased/skipped`のみ許可。`purchased → won`は訂正操作として許可する
 * （モバイル側で確認ダイアログを必須にする前提、バックエンドはホワイトリストのみ強制）。
 * `skipped → planned`（見送りの取り消し）を許可する。
 * `lost → applied`は明示的に禁止（10.2節）。
 */
const TRANSITIONS: Record<LotteryStatus, readonly LotteryStatus[]> = {
  unknown: ["planned", "applied", "won", "lost", "purchased", "skipped"],
  planned: ["applied", "skipped"],
  applied: ["won", "lost"],
  won: ["purchased", "skipped"],
  lost: [],
  purchased: ["won"],
  skipped: ["planned"],
};

/** 同一状態への「遷移」（実質no-op）は常に許可する（再送・冪等性のため）。 */
export function isValidTransition(from: LotteryStatus, to: LotteryStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}
