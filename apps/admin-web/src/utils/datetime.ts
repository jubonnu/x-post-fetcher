/**
 * DBの`_at`カラムに時刻情報の無い日付文字列（"YYYY-MM-DD"）がそのまま入っているケースを検出する。
 * 本来`_at`カラムは完全なISO datetimeを想定しているが、日付のみしか分からない項目のうち
 * 専用のdateカラムが無いもの（応募開始・購入開始・購入期限。締切/当選発表と違い
 * `applicationEndDate`のような対になるカラムが存在しない）は、抽出パイプラインが
 * 日付文字列をそのまま格納することがある。
 */
export function isBareDateOnly(value: string | null | undefined): value is string {
  return value != null && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * `<input type="datetime-local">`はタイムゾーン無しのローカル時刻文字列を扱うため、ISO文字列との相互変換が必要。
 * `isBareDateOnly`に該当する値（時刻情報が無い日付のみの文字列）をそのまま`new Date()`に渡すと
 * UTC 0時として解釈され、日本時間等では実在しない時刻（例: 09:00）が表示されてしまうため、
 * その場合は空文字を返す（別途「日付のみ」であることを表示側で案内する）。
 */
export function toDatetimeLocalValue(iso: string | null): string {
  if (!iso || isBareDateOnly(iso)) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromDatetimeLocalValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
