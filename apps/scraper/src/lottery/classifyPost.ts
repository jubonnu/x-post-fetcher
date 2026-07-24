import type { CardType, PostType } from "@x-post/shared";
import {
  CANCEL_SIGNALS,
  CARD_ONEPIECE,
  CARD_OTHER_TCG,
  CARD_POKEMON,
  EXTEND_SIGNALS,
  GENERAL_SALE_SIGNALS,
  LOTTERY_SIGNALS,
  PREPARATION_SIGNALS,
  PURCHASE_INFO_SIGNALS,
  RESERVATION_SIGNALS,
  RESTOCK_SIGNALS,
  RESULT_SIGNALS,
  SCHEDULED_SIGNALS,
  SUMMARY_SIGNALS,
} from "./keywords.ts";

export interface Classification {
  postType: PostType;
  isLotteryInformation: boolean;
  cardType: CardType;
  confidenceScore: number;
}

const has = (text: string, words: string[]) => words.some((w) => text.toLowerCase().includes(w.toLowerCase()));
const count = (text: string, words: string[]) =>
  words.reduce((n, w) => (text.toLowerCase().includes(w.toLowerCase()) ? n + 1 : n), 0);

export function detectCardType(text: string): CardType {
  if (has(text, CARD_POKEMON)) return "pokemon";
  if (has(text, CARD_ONEPIECE)) return "onepiece";
  if (has(text, CARD_OTHER_TCG)) return "other";
  return "unknown";
}

/** 抽選情報とみなす postType の集合 */
const LOTTERY_POST_TYPES = new Set<PostType>([
  "lottery_started",
  "lottery_summary",
  "lottery_scheduled",
  "lottery_updated",
  "deadline_extended",
  "result_announced",
  "purchase_information",
  "lottery_cancelled",
]);

/**
 * 投稿を分類する（ルールベース）。
 * 「抽選」という単語だけでは抽選情報と判定しない。事前準備投稿を先に除外する。
 */
export function classifyPost(bodyText: string): Classification {
  const text = bodyText ?? "";
  const cardType = detectCardType(text);

  const lotterySignalCount = count(text, LOTTERY_SIGNALS);
  const hasStrongLottery = lotterySignalCount > 0;
  const isPreparation = has(text, PREPARATION_SIGNALS) && !has(text, ["抽選開始されました", "応募受付中", "応募はこちら"]);

  let postType: PostType;

  if (has(text, CANCEL_SIGNALS) && !has(text, ["中止のお知らせはありません"])) {
    postType = "lottery_cancelled";
  } else if (has(text, EXTEND_SIGNALS)) {
    postType = "deadline_extended";
  } else if (has(text, RESULT_SIGNALS)) {
    postType = "result_announced";
  } else if (isPreparation) {
    // 事前準備（会員登録・購入履歴・「備えて」等）は抽選情報ではない
    postType = "lottery_preparation";
  } else if (has(text, SUMMARY_SIGNALS) && hasStrongLottery) {
    postType = "lottery_summary";
  } else if (has(text, PURCHASE_INFO_SIGNALS) && !hasStrongLottery) {
    postType = "purchase_information";
  } else if (hasStrongLottery) {
    postType = "lottery_started";
  } else if (has(text, RESERVATION_SIGNALS)) {
    postType = "reservation";
  } else if (has(text, RESTOCK_SIGNALS)) {
    postType = "restock";
  } else if (has(text, SCHEDULED_SIGNALS)) {
    postType = "lottery_scheduled";
  } else if (has(text, GENERAL_SALE_SIGNALS)) {
    postType = "general_sale";
  } else {
    postType = "unrelated";
  }

  const isLotteryInformation = LOTTERY_POST_TYPES.has(postType);

  // 信頼度: 抽選シグナル数と分類の確度から素朴に算出
  let confidenceScore = 0.3;
  if (postType === "unrelated") confidenceScore = 0.2;
  else if (postType === "lottery_preparation") confidenceScore = 0.7;
  else if (isLotteryInformation) confidenceScore = Math.min(0.95, 0.5 + lotterySignalCount * 0.15);
  else confidenceScore = 0.6;

  return { postType, isLotteryInformation, cardType, confidenceScore: Number(confidenceScore.toFixed(2)) };
}
