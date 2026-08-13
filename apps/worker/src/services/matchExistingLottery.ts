import { extractDomain } from "@x-post/shared";

/**
 * 同一抽選マッチング（Phase 3・純関数）。
 *
 * 手順（実装計画 §matchExistingLottery に準拠）:
 *  1. **禁止条件（ハードブロック）を先に評価**。該当すればスコアに関係なく統合しない（新規扱い）。
 *  2. ブロックされなかった既存だけをスコアリング（商品40 / 店舗30 / 支店地域10 / 締切15 / ドメイン5
 *     / 結果待ちボーナス15）。
 *  3. 最高スコアで判定: 80+ → merge / 50–79 → review / 49- → new。
 *
 * 注: オンライン/店頭・販売形態・抽選回（第2回等）のブロックは専用フィールド未整備のため Phase 3 では未実装
 * （カード種別・支店・締切差でブロック）。締切が未確定（unknown/not_published/store_closing_time）の場合は
 * 締切差でブロックしない。
 *
 * 結果待ちボーナス（15点）: 商品/店舗一致が既に40点以上あり、候補（新しい投稿）に当選発表情報が
 * 抽出できていて、既存側にはまだ無い場合に加点する。当選発表だけの短い後続投稿（例:「当選発表しました」）
 * は締切等の情報を再掲しないため、商品名+店舗名の完全一致だけでは70点にしか届かず自動マージの閾値(80)を
 * 超えられない。このボーナスにより、そうした「結果待ちの続報」を確実に自動マージできるようにする
 * （商品/店舗どちらも一致していない候補には加点しないため、無関係な抽選への誤統合リスクは抑えている）。
 */

export interface MatchableLottery {
  cardType?: string | null;
  normalizedProductName?: string | null;
  normalizedStoreName?: string | null;
  normalizedStoreBranch?: string | null;
  region?: string | null;
  applicationEndAt?: string | null;
  applicationEndDate?: string | null;
  applicationEndPrecision?: string | null;
  applicationUrl?: string | null;
  resultAnnouncementAt?: string | null;
  resultAnnouncementDate?: string | null;
}

export interface MatchOptions {
  deadlineBlockDays?: number; // 既定 7
  mergeThreshold?: number; // 既定 80
  reviewThreshold?: number; // 既定 50
}

export interface MatchResult {
  matchedIndex: number | null;
  score: number;
  action: "merge" | "review" | "new";
  reason: string;
}

const DEFAULTS = { deadlineBlockDays: 7, mergeThreshold: 80, reviewThreshold: 50 };

const norm = (s: string | null | undefined) => (s ?? "").trim();
const bothPresent = (a: string | null | undefined, b: string | null | undefined) =>
  norm(a).length > 0 && norm(b).length > 0;
const partialIncludes = (a: string, b: string) => (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a)));

/** 締切が「確定」した日付を持つか（未確定は締切ブロック・締切スコアの対象外） */
function resolvedEndDate(l: MatchableLottery): string | null {
  const p = l.applicationEndPrecision ?? "unknown";
  if (p !== "datetime" && p !== "date_only") return null;
  return l.applicationEndDate ?? null;
}

function dayDiff(d1: string, d2: string): number {
  const t1 = Date.parse(`${d1}T00:00:00Z`);
  const t2 = Date.parse(`${d2}T00:00:00Z`);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return 0;
  return Math.abs(t1 - t2) / 86_400_000;
}

/** 禁止条件（ハードブロック）。該当すれば理由文字列、なければ null。 */
export function hardBlockReason(a: MatchableLottery, b: MatchableLottery, opts: MatchOptions = {}): string | null {
  const deadlineBlockDays = opts.deadlineBlockDays ?? DEFAULTS.deadlineBlockDays;

  // カード種類が異なる（両方が既知で不一致）
  const ca = norm(a.cardType);
  const cb = norm(b.cardType);
  if (ca && cb && ca !== "unknown" && cb !== "unknown" && ca !== cb) return "card_type_differs";

  // 店舗支店が異なる（両方に支店があり不一致）
  if (bothPresent(a.normalizedStoreBranch, b.normalizedStoreBranch) && norm(a.normalizedStoreBranch) !== norm(b.normalizedStoreBranch)) {
    return "store_branch_differs";
  }

  // 応募締切が大きく異なる（両方が確定日付を持つ場合のみ。未確定はブロックしない）
  const da = resolvedEndDate(a);
  const db = resolvedEndDate(b);
  if (da && db && dayDiff(da, db) > deadlineBlockDays) return `deadline_diff_gt_${deadlineBlockDays}d`;

  return null;
}

/** スコアリング（0–115）。商品40 / 店舗30 / 支店地域10 / 締切15 / ドメイン5 / 結果待ちボーナス15。 */
export function scorePair(a: MatchableLottery, b: MatchableLottery): number {
  let score = 0;

  // 商品 40
  const pa = norm(a.normalizedProductName);
  const pb = norm(b.normalizedProductName);
  if (pa && pb) {
    if (pa === pb) score += 40;
    else if (partialIncludes(pa, pb)) score += 20;
  }

  // 店舗 30
  const sa = norm(a.normalizedStoreName);
  const sb = norm(b.normalizedStoreName);
  if (sa && sb) {
    if (sa === sb) score += 30;
    else if (partialIncludes(sa, sb)) score += 15;
  }

  // 結果待ちボーナス 15: 商品/店舗一致で既に40点以上あり、候補に当選発表情報があり、既存には無い場合。
  const productStoreScore = score;
  const candidateHasResult = norm(a.resultAnnouncementAt).length > 0 || norm(a.resultAnnouncementDate).length > 0;
  const existingLacksResult = norm(b.resultAnnouncementAt).length === 0 && norm(b.resultAnnouncementDate).length === 0;
  if (productStoreScore >= 40 && candidateHasResult && existingLacksResult) score += 15;

  // 支店 + 地域 10（各5）
  if (bothPresent(a.normalizedStoreBranch, b.normalizedStoreBranch) && norm(a.normalizedStoreBranch) === norm(b.normalizedStoreBranch)) score += 5;
  if (bothPresent(a.region, b.region) && norm(a.region) === norm(b.region)) score += 5;

  // 締切 15（同日15 / 1日差8）
  const da = resolvedEndDate(a);
  const db = resolvedEndDate(b);
  if (da && db) {
    const diff = dayDiff(da, db);
    if (diff === 0) score += 15;
    else if (diff <= 1) score += 8;
  }

  // 応募URLドメイン 5
  if (bothPresent(a.applicationUrl, b.applicationUrl)) {
    const domA = extractDomain(a.applicationUrl!);
    const domB = extractDomain(b.applicationUrl!);
    if (domA && domB && domA === domB) score += 5;
  }

  return score;
}

/**
 * 候補を既存抽選群に照合する。禁止条件を通過した中で最高スコアの既存を返す。
 */
export function matchExistingLottery(
  candidate: MatchableLottery,
  existing: MatchableLottery[],
  opts: MatchOptions = {}
): MatchResult {
  const mergeThreshold = opts.mergeThreshold ?? DEFAULTS.mergeThreshold;
  const reviewThreshold = opts.reviewThreshold ?? DEFAULTS.reviewThreshold;

  let best: { index: number; score: number } | null = null;
  let lastBlock: string | null = null;

  existing.forEach((ex, index) => {
    const block = hardBlockReason(candidate, ex, opts);
    if (block) {
      lastBlock = block;
      return; // スコアが高くても統合しない
    }
    const score = scorePair(candidate, ex);
    if (!best || score > best.score) best = { index, score };
  });

  if (!best) {
    return { matchedIndex: null, score: 0, action: "new", reason: lastBlock ? `blocked:${lastBlock}` : "no_candidate" };
  }
  const b = best as { index: number; score: number };
  if (b.score >= mergeThreshold) return { matchedIndex: b.index, score: b.score, action: "merge", reason: "score_merge" };
  if (b.score >= reviewThreshold) return { matchedIndex: b.index, score: b.score, action: "review", reason: "score_review" };
  return { matchedIndex: null, score: b.score, action: "new", reason: "score_below_review" };
}
