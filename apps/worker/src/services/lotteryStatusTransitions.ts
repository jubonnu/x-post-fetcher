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
 *
 * 決定事項（2026-08、統計の応募試行集計の設計時に検討）:
 * `skipped → won`（`purchased → won`と対称的な「購入見送りの訂正」）は**意図的に許可しない**。
 * 理由: 現状`skipped`は「応募前の見送り」（`planned/unknown → skipped`）と「当選後の購入見送り」
 * （`won → skipped`）の2つの意味が単一のstatus値に混在しており、単一status設計のまま
 * `skipped → won`を許可すると、統計の応募試行集計（`services/lotteryAttempts.ts`）側で
 * 誤集計の余地が生まれる（例: 応募前見送りだったものを誤って当選訂正扱いしてしまう等）。
 * 統計の集計関数自体は`skipped → won`が来ても防御的に処理できるが、それは将来この制約が
 * 緩和された場合への備えであり、現在のAPIとしては引き続き禁止する。
 * 将来的な検討事項: `application`（応募したか）・`result`（当選/落選）・`purchase`（購入/見送り）を
 * 別軸のフィールドに分離すれば、この曖昧さを構造的に解消できる。
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
