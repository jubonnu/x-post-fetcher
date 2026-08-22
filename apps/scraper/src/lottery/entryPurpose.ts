export type EntryPurpose = "new_lottery" | "summary" | "result" | "ignored";

/** 全角/半角スペース・改行・タブを除去し、NFKC正規化する（表記揺れ対策）。 */
function normalize(text: string): string {
  return (text ?? "").replace(/[\s\u3000]+/g, "").normalize("NFKC");
}

const RESULT_ENTRY_KEYWORDS = ["抽選結果発表"].map(normalize);
const SUMMARY_ENTRY_KEYWORDS = ["抽選まとめ", "抽選全てまとめ", "全てをまとめ", "抽選中全てまとめ", "抽選 まとめ"].map(normalize);
const NEW_LOTTERY_ENTRY_KEYWORDS = ["抽選開始", "抽選告知", "抽選受付"].map(normalize);
const NEW_LOTTERY_MARKER = normalize("抽選");
const START_MARKER = normalize("スタート");
/** 締切マーカー「〆」。価格情報ダイジェスト投稿（「トレカ情報まとめ」等）はこの記号を一切
 * 使わないため、店舗・締切を列挙した抽選まとめ投稿だけを安全に判別できる（下記参照）。 */
const DEADLINE_MARKER = "〆";
const MIN_DEADLINE_MARKERS_FOR_SUMMARY = 2;

/**
 * 投稿本文を目的別（new_lottery/summary/result/ignored）に分類する、抽出とは独立した
 * 「lottery解析へ進めるかどうか」の絞り込みゲート。classifyPost.ts の広いシグナルベース
 * 分類（LOTTERY_SIGNALS等）とは別軸で、2026-08の実データ確認に基づく限定的なキーワード
 * 一致のみを判定基準にする（詳細な postType 判定・信頼度算出は classifyPost.ts に残す）。
 *
 * 優先順位: result > summary > new_lottery > ignored（1投稿が複数該当しうるため）。
 * 2026-08実データでは複数該当する投稿は無かったが、将来のデータで該当した場合の保険として
 * この順序を維持する。
 */
export function classifyEntryPurpose(bodyText: string): EntryPurpose {
  const norm = normalize(bodyText);

  if (RESULT_ENTRY_KEYWORDS.some((k) => norm.includes(k))) return "result";
  if (SUMMARY_ENTRY_KEYWORDS.some((k) => norm.includes(k))) return "summary";
  if (NEW_LOTTERY_ENTRY_KEYWORDS.some((k) => norm.includes(k))) return "new_lottery";
  // 「スタート」単体では判定しない。「抽選」と「スタート」を両方含む場合のみ new_lottery とする
  // （2026-08実データ「...抽選企画がスタートしました」等、"抽選開始"の表記揺れに対応するため）。
  if (norm.includes(NEW_LOTTERY_MARKER) && norm.includes(START_MARKER)) return "new_lottery";
  // 「抽選」を含み、締切マーカー「〆」が複数あれば、上記どのキーワードにも一致しない言い回しでも
  // 店舗・締切を列挙した抽選まとめ投稿とみなす（2026-08、sourcePostId=261で確認: 「今週開始した
  // 抽選増えたのでまとめておきました」という言い回しがどのキーワードにも一致せず、20件近い
  // 抽選情報が丸ごと抽出されずに失われていた）。
  const deadlineMarkerCount = norm.split(DEADLINE_MARKER).length - 1;
  if (norm.includes(NEW_LOTTERY_MARKER) && deadlineMarkerCount >= MIN_DEADLINE_MARKERS_FOR_SUMMARY) return "summary";

  return "ignored";
}
