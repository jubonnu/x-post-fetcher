/** 分類・抽出に使うキーワード群（ルールベース） */

/** 抽選情報である可能性を高める強いシグナル */
export const LOTTERY_SIGNALS = [
  "抽選開始",
  "応募受付中",
  "応募期間",
  "応募開始",
  "締切",
  "当選発表",
  "購入期限",
  "応募はこちら",
  "抽選販売",
  "抽選受付",
];

/** 「抽選」語があっても抽選情報ではない＝事前準備を示すフレーズ */
export const PREPARATION_SIGNALS = [
  "備えて",
  "スムーズにするため",
  "済ませておきましょう",
  "済ませておく",
  "作っておきましょう",
  "会員登録",
  "購入履歴",
  "事前準備",
  "登録しておく",
  "抽選開始したら",
];

export const CANCEL_SIGNALS = ["抽選中止", "中止", "キャンセル", "取り止め", "取りやめ"];
export const RESULT_SIGNALS = ["当選発表", "当選者発表", "抽選結果", "当落"];
export const EXTEND_SIGNALS = ["延長", "締切延長", "期限延長"];
export const RESERVATION_SIGNALS = ["予約開始", "予約受付", "予約販売", "ご予約"];
export const RESTOCK_SIGNALS = ["再販", "再入荷", "再入荷情報", "入荷"];
export const GENERAL_SALE_SIGNALS = ["発売", "通常販売", "先着", "販売開始", "店頭販売"];
export const SCHEDULED_SIGNALS = ["発売予定", "今後", "予定です", "販売スケジュール"];
export const PURCHASE_INFO_SIGNALS = ["購入期間", "受取期間", "購入方法", "受け取り", "支払方法"];
export const SUMMARY_SIGNALS = ["まとめ", "全抽選", "抽選まとめ", "販売スケジュール"];

/** カード種類の判定 */
export const CARD_POKEMON = ["ポケモンカード", "ポケカ", "pokemon", "ポケモン"];
export const CARD_ONEPIECE = ["ワンピースカード", "ワンピース", "one piece", "opcg"];
export const CARD_OTHER_TCG = ["トレカ", "カード", "tcg"];

export const NOT_PUBLISHED_SIGNALS = ["未公開", "後日", "近日", "未定", "決まり次第", "追ってお知らせ"];
