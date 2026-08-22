import { computeContentHash, type AnalysisInput } from "@x-post/shared";
import type { RawPost } from "../scraping/x/parseTweetDom.ts";
import { classifyPost } from "./classifyPost.ts";
import { classifyPostUrls } from "./classifyUrls.ts";
import { classifyEntryPurpose } from "./entryPurpose.ts";
import { extractSingleLottery, LIST_MARKER_PATTERN, resolveApplicationUrl, splitLotteries, stripLabelSections } from "./extractLotteryData.ts";

/**
 * ルールパーサのバージョン（再解析キー。ロジック改善で上げる → 既存投稿が再解析される）。
 * 6: applicationUrl決定にallowlist外ドメインのフォールバック（文言近接/店舗公式ドメイン/
 *    単一URL）を追加（2026-08）。
 * 7: splitLotteries（複数商品まとめ投稿の分割）で、商品ごとに直後の個別URLを優先して
 *    割り当てるよう修正（それまでは投稿内の最初のURLを全商品で共有してしまっていた。
 *    2026-08、sourcePostId=251で確認）。
 * 8: splitLotteriesの(0)(1)分岐（【商品名】セクション＋✅店舗マーカー形式・✅店舗マーカーのみの
 *    まとめ投稿）にも同様の個別URL割り当てを適用（7では(2)分岐＝「商品「」直後にURL」形式のみ
 *    対応していた。2026-08、sourcePostId=149で確認）。
 * 9: 店舗公式ドメイン対応表（STORE_OFFICIAL_DOMAINS）に実データから判明した店舗を追加登録
 *    （p-bandai.jp/edion-cp.com/konamistyle.jp/dmm.com/hareruya2.com/limited.yodobashi.com/
 *    books.rakuten.co.jp/jumpshop-benelic.com/online.ministop.co.jp/iyec.itoyokado.co.jp）。
 *    加えて汎用の抽選代行プラットフォーム（customform.jp/shoplottery.e-starbox.com）を
 *    classifyUrlのallowlistに追加（2026-08）。
 * 10: splitLotteriesの(0)分岐で、✅店舗行の直後に・支店行が続く2階層構造
 *     （例:「✅ONEPIECE麦わらストア」→「・渋谷本店」「・池袋店」...）に対応。✅行自体は
 *     支店を1件以上持てば単独エントリーを作らず、各・行を「親店舗名+storeBranchRaw」として
 *     個別展開する（それまでは✅行が直後の1件目の支店と同じURLを拾い重複行になっていた。
 *     2026-08、sourcePostId=149「受け継がれる意志」で確認）。
 * 11: 見出し【】自体が「A/B/C」のように複数商品を「/」結合したラベルの場合、後続の・行の
 *     テキストが見出しのトークンに一致すれば「支店」ではなく「商品」として分割するよう修正
 *     （10の支店ロジックをそのまま適用すると、・行が実は商品名なのに結合済み見出し全体が
 *     productNameRawになってしまっていた。2026-08、sourcePostId=253で確認。251と同一内容が
 *     別の書式で投稿されていたケース）。
 * 12: 【】見出しの下に✅店舗マーカーが1件も無く・行だけが並ぶ「フラットな商品リスト」形式
 *     （見出し自体が「【応募締切】」のような締切ラベルで、店舗は投稿冒頭の「<店舗>で...」から
 *     共通で取る投稿）に対応。10の支店ロジックが誤って1行目の商品を店舗扱い・消失させ、
 *     2件目以降も見出しラベル＝商品名・1行目の商品名＝店舗名という入れ替わったデータを
 *     生成していた（2026-08、sourcePostId=267で確認）。
 */
export const PARSER_VERSION = "phase3-rules-12";

interface ComplexitySignals {
  productCount: number;
  storeMarkerCount: number;
  hasMultiSection: boolean;
}

function complexitySignals(bodyText: string): ComplexitySignals {
  const body = bodyText ?? "";
  const productCount = (body.match(/[「『][^」』]{1,60}[」』]/g) ?? []).length;
  // splitLotteriesのmarkerLines判定（LIST_MARKER_PATTERN・ラベル節除外）と同じ基準で数える
  // （ズレると「複数と判定されたのに分割パターンが拾えない」不整合が起きるため）。
  const storeMarkerCount = stripLabelSections(body)
    .split(/\n+/)
    .filter((l) => LIST_MARKER_PATTERN.test(l)).length;
  const hasMultiSection = /応募期間/.test(body) && /当選発表/.test(body);
  return { productCount, storeMarkerCount, hasMultiSection };
}

/**
 * 複数店舗・複数商品・複数セクションを含む「複雑/曖昧」な投稿かを素朴に判定。
 * ルールでは安全に分割できないため needs_review に落とす（分割は Phase 3）。
 */
export function assessComplexity(bodyText: string): boolean {
  const s = complexitySignals(bodyText);
  return s.productCount > 1 || s.storeMarkerCount > 1 || s.hasMultiSection;
}

/**
 * 実際に複数の商品・店舗マーカーが存在するか（`hasMultiSection`だけでは「複数」とは言えない）。
 * 「応募期間」「当選発表」の両方を書いただけの、ごく普通の単一抽選投稿でも`assessComplexity`は
 * trueになる。分割に失敗した際、これがfalse（＝本当は単一の投稿だった）なら単一抽出の結果を
 * そのまま採用してよいが、trueなら複数項目のうち一部だけを黙って採用してしまうことになるため
 * needs_reviewへ落とす必要がある（2026-08、実データで確認: この区別が無いと「応募期間」
 * 「当選発表」を両方書いた普通の単一抽選投稿が軒並みneeds_reviewになっていた）。
 */
function hasMultipleDistinctItems(bodyText: string): boolean {
  const s = complexitySignals(bodyText);
  return s.productCount > 1 || s.storeMarkerCount > 1;
}

/**
 * 投稿を解析して AnalysisInput を生成する（scraper 側・100% ルールベース）。
 *  - まず entryPurpose（目的別キーワードゲート）で「lottery解析へ進めるか」を判定する。
 *    ignored（新規抽選/まとめ/結果発表のいずれのキーワードにも該当しない）は抽出を一切行わない
 *    （2026-08実データで、classifyPostの広いシグナルだけでは無関係な投稿への誤抽出が多かったため）。
 *  - 単純な1店舗1商品はルール単一抽出（商品/店舗が揃えば success、欠ければ needs_review）。
 *  - 複数店舗・複数商品・複数セクションはルールでは分割できないため needs_review（分割は Phase 3）。
 *  - result（抽選結果発表）は、既存抽選とマッチしなければ新規lotteryとして確定登録させたくないため、
 *    抽出後に analysisStatus を強制的に needs_review へ落とす（Worker側 persistAnalysis の
 *    既存の降格ロジックを利用する。マッチした場合は matchExistingLottery が候補としてルーティング
 *    するため、この降格の影響を受けず既存抽選への自動反映は起きない）。
 * 日時は常にルール(resolveDate)で確定する。LLM は使用しない。
 */
export async function analyzePost(post: RawPost): Promise<AnalysisInput> {
  const cls = classifyPost(post.bodyText);
  const entryPurpose = classifyEntryPurpose(post.bodyText);
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

  // 目的別キーワードに非該当 → 抽選抽出しない（source_post自体は従来どおり保存される）
  if (entryPurpose === "ignored") {
    return { ...base, isLotteryInformation: false };
  }

  const single = extractSingleLottery(post.bodyText, post.publishedAt, urls);
  const singleOk = Boolean(single.productNameRaw && single.storeNameRaw);

  let result: AnalysisInput;

  // 複雑/曖昧（複数店舗・複数商品）→ ルールで分割を試みる（Phase 3）。
  // 確実に分割でき（各件に商品と店舗が揃う）→ success。
  if (assessComplexity(post.bodyText)) {
    const split = splitLotteries(post.bodyText, post.publishedAt, urls, post.externalLinks);
    if (split && split.length >= 2 && split.every((l) => l.productNameRaw && l.storeNameRaw)) {
      result = { ...base, extractedLotteries: split, analysisStatus: "success" };
    } else if (singleOk && !hasMultipleDistinctItems(post.bodyText)) {
      // 分割できなかった場合: 実際には複数商品/店舗マーカーが無い（＝「応募期間」「当選発表」を
      // 両方書いただけの普通の単一抽選投稿）で、単一抽出が成功していればそれをsuccessとして採用する。
      result = { ...base, extractedLotteries: [single], analysisStatus: "success" };
    } else {
      // 実際に複数マーカーが存在するのに分割できなかった場合のみneeds_reviewへ落とす
      // （一部項目だけを黙って採用してしまうことを避けるため）。
      result = { ...base, extractedLotteries: [single], analysisStatus: "needs_review" };
    }
  } else {
    // 単純 → ルール単一抽出で確定（商品/店舗が欠ける場合は判定不能として needs_review）
    result = { ...base, extractedLotteries: [single], analysisStatus: singleOk ? "success" : "needs_review" };
  }

  if (entryPurpose === "result" && result.analysisStatus !== "needs_review") {
    result = { ...result, analysisStatus: "needs_review" };
  }

  // 応募URL候補が複数あり機械的に判別できなかった場合、URL自体（urls配列）は保持したまま
  // needs_reviewへ落とす（applicationUrlを誤って確定させないため。2026-08）。
  if (resolveApplicationUrl(urls, post.bodyText ?? "").needsReview && result.analysisStatus !== "needs_review") {
    result = { ...result, analysisStatus: "needs_review" };
  }

  return result;
}
