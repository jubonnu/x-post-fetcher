import { computeContentHash, type AnalysisInput } from "@x-post/shared";
import type { RawPost } from "../scraping/x/parseTweetDom.ts";
import { classifyPost } from "./classifyPost.ts";
import { classifyPostUrls } from "./classifyUrls.ts";
import { extractSingleLottery, splitLotteries } from "./extractLotteryData.ts";

/** ルールパーサのバージョン（再解析キー。ロジック改善で上げる → 既存投稿が再解析される） */
export const PARSER_VERSION = "phase3-rules-1";

/**
 * 複数店舗・複数商品・複数セクションを含む「複雑/曖昧」な投稿かを素朴に判定。
 * ルールでは安全に分割できないため needs_review に落とす（分割は Phase 3）。
 */
export function assessComplexity(bodyText: string): boolean {
  const body = bodyText ?? "";
  const productCount = (body.match(/[「『][^」』]{1,60}[」』]/g) ?? []).length;
  const storeMarkerCount = (body.match(/^[\s]*[✅✔・]/gm) ?? []).length;
  const hasMultiSection = /応募期間/.test(body) && /当選発表/.test(body);
  return productCount > 1 || storeMarkerCount > 1 || hasMultiSection;
}

/**
 * 投稿を解析して AnalysisInput を生成する（scraper 側・100% ルールベース）。
 *  - 明確な非抽選（unrelated/preparation/restock 等）は抽選抽出しない。
 *  - 単純な1店舗1商品はルール単一抽出（商品/店舗が揃えば success、欠ければ needs_review）。
 *  - 複数店舗・複数商品・複数セクションはルールでは分割できないため needs_review（分割は Phase 3）。
 * 日時は常にルール(resolveDate)で確定する。LLM は使用しない。
 */
export async function analyzePost(post: RawPost): Promise<AnalysisInput> {
  const cls = classifyPost(post.bodyText);
  const urls = classifyPostUrls(post.externalLinks, post.imageUrls);
  const inputContentHash = await computeContentHash(post.bodyText);

  const base: AnalysisInput = {
    postType: cls.postType,
    isLotteryInformation: cls.isLotteryInformation,
    cardType: cls.cardType,
    confidenceScore: cls.confidenceScore,
    analysisStatus: "success",
    parserVersion: PARSER_VERSION,
    inputContentHash,
    extractedLotteries: [],
    urls,
    errorMessage: null,
  };

  // 明確な非抽選 → 抽選抽出しない
  if (!cls.isLotteryInformation) {
    return base;
  }

  const single = extractSingleLottery(post.bodyText, post.publishedAt, urls);

  // 複雑/曖昧（複数店舗・複数商品）→ ルールで分割を試みる（Phase 3）。
  // 確実に分割でき（各件に商品と店舗が揃う）→ success。分割できなければ単一 + needs_review。
  if (assessComplexity(post.bodyText)) {
    const split = splitLotteries(post.bodyText, post.publishedAt, urls);
    if (split && split.length >= 2 && split.every((l) => l.productNameRaw && l.storeNameRaw)) {
      return { ...base, extractedLotteries: split, analysisStatus: "success" };
    }
    return { ...base, extractedLotteries: [single], analysisStatus: "needs_review" };
  }

  // 単純 → ルール単一抽出で確定（商品/店舗が欠ける場合は判定不能として needs_review）
  const ok = Boolean(single.productNameRaw && single.storeNameRaw);
  return { ...base, extractedLotteries: [single], analysisStatus: ok ? "success" : "needs_review" };
}
