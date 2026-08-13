import { resolveDate, type ClassifiedUrl, type ExtractedLottery, type ResolvedDate } from "@x-post/shared";
import { detectCardType } from "./classifyPost.ts";
import { NOT_PUBLISHED_SIGNALS } from "./keywords.ts";

/**
 * 複数店舗・複数商品の「まとめ投稿」で、1件ごとの見出しに使われる行頭マーカー。
 * `assessComplexity`（analyzePost.ts）と`splitLotteries`の両方で同じ判定基準を使うため、
 * ここで一元管理する（ズレると「複数と判定されたのに分割パターンが拾えない」不整合が起きる）。
 * 対応: ✅/✔/・ の記号、丸数字（①〜⑳）、キーキャップ絵文字（1️⃣〜9️⃣・🔟）、▼/■/★、
 * 半角/全角の番号リスト（1. / １．）。
 */
export const LIST_MARKER_PATTERN =
  /^\s*(?:[✅✔・▼■★]|[①-⑳]|[0-9]️?⃣|\u{1F51F}|\d+[.．]|[０-９]+[.．])/u;

/** 行頭のマーカーを取り除いた残り部分を返す。 */
export function stripListMarker(line: string): string {
  return line.replace(LIST_MARKER_PATTERN, "").trim();
}

const emptyResolved = (): ResolvedDate => ({
  at: null,
  date: null,
  precision: "unknown",
  status: "unknown",
  rawText: null,
  yearInferred: false,
});

const hasAny = (text: string, words: string[]) => words.some((w) => text.includes(w));

/** 指定キーワードを含む行を返す（複数該当は最初） */
function lineContaining(body: string, keywords: string[]): string | null {
  for (const line of body.split(/\n+/)) {
    if (keywords.some((k) => line.includes(k))) return line.trim();
  }
  return null;
}

/**
 * 日付フィールドを抽出。
 * - キーワード行があり日付が取れれば resolveDate
 * - キーワード行はあるが「未公開/後日/未定」等なら not_published
 */
function fieldDate(body: string, keywords: string[], post: string | null): ResolvedDate {
  const line = lineContaining(body, keywords);
  if (!line) return emptyResolved();
  const rd = resolveDate(line, post);
  if (rd.precision !== "unknown") return rd;
  if (hasAny(line, NOT_PUBLISHED_SIGNALS) || hasAny(body, NOT_PUBLISHED_SIGNALS)) {
    return { ...emptyResolved(), status: "not_published", rawText: line };
  }
  return { ...emptyResolved(), rawText: line };
}

function firstUrlOfType(urls: ClassifiedUrl[], type: ClassifiedUrl["urlType"]): string | null {
  return urls.find((u) => u.urlType === type)?.originalUrl ?? null;
}

/** 先頭の店舗名らしき語を抽出（"<店舗>で..." / "<店舗>では..."） */
function extractStoreName(body: string): string | null {
  const firstLine = body.split(/\n+/)[0] ?? "";
  const m = firstLine.match(/^\s*([^\s。、「」]{2,20}?)(?:で|では|にて)/);
  return m ? m[1] : null;
}

/** 商品名（最初の「」内） */
function extractProductName(body: string): string | null {
  const m = body.match(/[「『]([^」』]{1,60})[」』]/);
  return m ? m[1] : null;
}

/** まとめ投稿のヘッダ商品名（「」内 or 先頭行から「まとめ/全抽選/抽選」以降を除去） */
function extractHeaderProduct(body: string): string | null {
  const quoted = extractProductName(body);
  if (quoted) return quoted;
  const firstLine = (body.split(/\n+/)[0] ?? "").trim();
  const stripped = firstLine.replace(/(全抽選まとめ|抽選まとめ|まとめ|全抽選|抽選).*$/, "").trim();
  return stripped.length >= 2 ? stripped : null;
}

/**
 * 1投稿から「単一の」抽選情報を抽出する（Phase 2）。
 * 複数店舗・複数商品の分割は Phase 3 の担当。ここでは Raw 値のまま返す（正規化は Worker）。
 */
export function extractSingleLottery(
  bodyText: string,
  postPublishedAt: string | null,
  urls: ClassifiedUrl[]
): ExtractedLottery {
  const body = bodyText ?? "";

  const applicationStart = fieldDate(body, ["応募開始", "受付開始", "抽選開始日"], postPublishedAt);
  const applicationEnd = fieldDate(body, ["応募期間", "締切", "〆", "まで"], postPublishedAt);
  const resultAnnouncement = fieldDate(body, ["当選発表", "当選者発表", "抽選結果"], postPublishedAt);
  const purchaseStart = fieldDate(body, ["購入期間", "購入開始", "受取開始"], postPublishedAt);
  const purchaseDeadline = fieldDate(body, ["購入期限", "受取期限", "支払期限"], postPublishedAt);

  // 「抽選開始されました」だけで開始日時が不明なら、投稿日時を confirmedOpenAt に保存
  const startedNow = /抽選開始されました|抽選開始しました|抽選が開始|受付開始しました/.test(body);
  const confirmedOpenAt = startedNow && applicationStart.precision === "unknown" ? postPublishedAt : null;

  const applicationUrl = firstUrlOfType(urls, "application");
  const officialInformationUrl = firstUrlOfType(urls, "official_information");
  const appDownloadUrl = firstUrlOfType(urls, "app_download");

  // 応募方法・受取・支払（行抽出）
  const applicationMethodLine = lineContaining(body, ["から応募", "応募方法", "QRコード", "から抽選"]);
  const pickupLine = lineContaining(body, ["受取", "受け取り", "店頭受取"]);
  const paymentLine = lineContaining(body, ["支払", "決済"]);
  const priceLine = lineContaining(body, ["円", "価格", "税込"]);

  return {
    cardType: detectCardType(body),
    productNameRaw: extractProductName(body),
    storeNameRaw: extractStoreName(body),
    storeBranchRaw: null,
    region: null,
    applicationStart,
    applicationEnd,
    resultAnnouncement,
    purchaseStart,
    purchaseDeadline,
    confirmedOpenAt,
    applicationUrl,
    officialInformationUrl,
    appDownloadUrl,
    applicationMethod: applicationMethodLine,
    eligibilityConditions: null,
    pickupMethod: pickupLine,
    paymentMethod: paymentLine,
    price: priceLine && /円/.test(priceLine) ? priceLine : null,
    notes: null,
  };
}

/**
 * 1投稿を「複数の」抽選へ分割する（Phase 3）。
 *  - 店舗マーカー行（LIST_MARKER_PATTERN + 店舗 + 締切）が2つ以上 → まとめ投稿として店舗ごとに分割
 *    （各行が独自の「」商品名を持てばそれを使用、無ければヘッダ商品を流用。締切は各行のインライン日付）。
 *  - マーカーが無くても 商品「」が2つ以上 + 共通店舗が取れる → 商品ごとに分割。
 *  - 確実に分割できなければ null（呼び出し側は needs_review へ）。
 * 日時はルール(resolveDate)で確定し、LLM は使用しない。
 */
export function splitLotteries(
  bodyText: string,
  postPublishedAt: string | null,
  urls: ClassifiedUrl[]
): ExtractedLottery[] | null {
  const body = bodyText ?? "";
  const lines = body.split(/\n+/);
  const markerLines = lines.filter((l) => LIST_MARKER_PATTERN.test(l));
  const headerProduct = extractHeaderProduct(body);

  const cardType = detectCardType(body);
  const resultAnnouncement = fieldDate(body, ["当選発表", "当選者発表", "抽選結果"], postPublishedAt);
  const applicationUrl = firstUrlOfType(urls, "application");
  const officialInformationUrl = firstUrlOfType(urls, "official_information");
  const appDownloadUrl = firstUrlOfType(urls, "app_download");

  const make = (product: string | null, store: string | null, applicationEnd: ResolvedDate): ExtractedLottery => ({
    cardType,
    productNameRaw: product,
    storeNameRaw: store,
    storeBranchRaw: null,
    region: null,
    applicationStart: emptyResolved(),
    applicationEnd,
    resultAnnouncement,
    purchaseStart: emptyResolved(),
    purchaseDeadline: emptyResolved(),
    confirmedOpenAt: null,
    applicationUrl,
    officialInformationUrl,
    appDownloadUrl,
    applicationMethod: null,
    eligibilityConditions: null,
    pickupMethod: null,
    paymentMethod: null,
    price: null,
    notes: null,
  });

  // (1) 店舗マーカー行が2つ以上 → 店舗ごとに分割
  // 各行が独自の「」商品名を持つ場合はそれを使用する（店舗ごとに商品が異なるまとめ投稿）。
  // 無ければ従来通りヘッダ商品を共通で使う。
  if (markerLines.length >= 2) {
    return markerLines.map((line) => {
      const rest = stripListMarker(line);
      const lineProduct = extractProductName(rest);
      const withoutProduct = lineProduct ? rest.replace(/[「『][^」』]{1,60}[」』]/, "").trim() : rest;
      const m = withoutProduct.match(/^([^\d]+?)\s*([\d/].*)?$/);
      const store = (m ? m[1] : withoutProduct).trim() || null;
      const dateText = m && m[2] ? m[2] : null;
      const applicationEnd = dateText ? resolveDate(dateText, postPublishedAt) : emptyResolved();
      return make(lineProduct ?? headerProduct, store, applicationEnd);
    });
  }

  // (2) 商品「」が2つ以上 + 共通店舗 → 商品ごとに分割
  const products = [...body.matchAll(/[「『]([^」』]{1,60})[」』]/g)].map((x) => x[1]);
  const uniqueProducts = [...new Set(products)];
  const store = extractStoreName(body);
  if (uniqueProducts.length >= 2 && store) {
    const applicationEnd = fieldDate(body, ["応募期間", "締切", "〆", "まで"], postPublishedAt);
    return uniqueProducts.map((p) => make(p, store, applicationEnd));
  }

  return null;
}
