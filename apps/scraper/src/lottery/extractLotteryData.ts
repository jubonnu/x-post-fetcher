import { resolveDate, type ClassifiedUrl, type ExtractedLottery, type ResolvedDate } from "@x-post/shared";
import { detectCardType } from "./classifyPost.ts";
import { NOT_PUBLISHED_SIGNALS } from "./keywords.ts";

/**
 * 複数店舗・複数商品の「まとめ投稿」で、1件ごとの見出しに使われる行頭マーカー。
 * `assessComplexity`（analyzePost.ts）と`splitLotteries`の両方で同じ判定基準を使うため、
 * ここで一元管理する（ズレると「複数と判定されたのに分割パターンが拾えない」不整合が起きる）。
 * 対応: ✅/✔/・ の記号、丸数字（①〜⑳）、キーキャップ絵文字（1️⃣〜9️⃣・🔟）、
 * 半角/全角の番号リスト（1. / １．）。
 *
 * 「▼/■/★」は含めない: 実データで、1つの抽選（例:「✅ジャンプショップ」）の下に
 * 「■札幌店 URL」「■仙台店 URL」のように**同一抽選の受取可能店舗一覧**を■付きで
 * 列挙するケースがあり、これをトップレベルの区切りマーカーとして扱うと1件の抽選が
 * 店舗数だけ誤って分割されてしまう（2026-08、実データで確認・修正）。
 */
export const LIST_MARKER_PATTERN = /^\s*(?:[✅✔・]|[①-⑳]|[0-9]️?⃣|\u{1F51F}|\d+[.．]|[０-９]+[.．])/u;

/** 行頭のマーカーを取り除いた残り部分を返す。 */
export function stripListMarker(line: string): string {
  return line.replace(LIST_MARKER_PATTERN, "").trim();
}

/**
 * 単一抽選投稿で【】がフィールドラベルとして使われる際に共通して含まれる語根。
 * 完全一致ではなく部分一致で判定する（「対象商品」「対象商品一覧」「支払方法」等、語の組み合わせが
 * 多様なため）。実データで、【】の下に「・」や丸数字の箇条書き（商品バリエーションの列挙・認証手順の
 * 説明等）が続くケースがあり、これをそのまま商品/店舗として抽出すると誤ったデータになるため
 * 除外する（2026-08、実データで確認）。商品名がこれらの語を部分文字列として含む可能性は
 * 実用上無視できるほど低い。
 */
const SECTION_LABEL_STOPWORD_ROOTS = [
  "期間",
  "期限",
  "方法",
  "手順",
  "注意",
  "対象",
  "備考",
  "補足",
  // 「発表」「結果」「条件」が無いと、【当選発表】【応募条件】等のフィールドラベル節にある
  // 「・商品名」の列挙や丸数字の箇条書き（実際はリンク列挙・応募条件の説明で、店舗ごとの
  // 分割対象ではない）を、splitLotteriesのパターン(0)が商品グループ見出しと誤認し、
  // 商品=ラベル名・店舗=各行、という入れ替わったデータを生成してしまう
  // （2026-08、実データ sourcePostId=115,125 等で確認。198投稿中に同種の商品名衝突が
  // 無いことも確認済み）。
  "発表",
  "結果",
  "条件",
];

function isSectionLabel(header: string): boolean {
  return SECTION_LABEL_STOPWORD_ROOTS.some((root) => header.includes(root));
}

/**
 * 【応募期間】【手順】のようなフィールドラベルの節の中身を本文から取り除く。
 * ラベル節の中にも「・」や丸数字の箇条書きが含まれることがあり、これを除去せずに
 * マーカー行を数える/分割すると、ラベル節の中身（商品バリエーションの列挙・手順の説明等）を
 * 誤って店舗として扱ってしまう（`assessComplexity`のstoreMarkerCount、`splitLotteries`の
 * パターン(1)の両方で使う。パターン(0)は【】そのものを見るため対象外）。
 */
export function stripLabelSections(body: string): string {
  return body.replace(/【([^】]{1,100})】([\s\S]*?)(?=【|$)/g, (whole, header: string) =>
    isSectionLabel(header.trim()) ? "" : whole
  );
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

/** 指定キーワードを含む行のインデックスを返す（複数該当は最初） */
function lineIndexContaining(lines: string[], keywords: string[]): number {
  return lines.findIndex((line) => keywords.some((k) => line.includes(k)));
}

/** URL行かどうか（次行探索で日付として誤認しないよう除外するため） */
function looksLikeUrl(line: string): boolean {
  return /^(?:https?:\/\/|www\.)/i.test(line);
}

/** 次行探索で日付候補として試す価値が無い行かどうか（URL/価格/電話番号等） */
function looksLikeNonDateLine(line: string): boolean {
  if (!line) return true;
  if (looksLikeUrl(line)) return true;
  return false;
}

/**
 * 日付フィールドを抽出。
 * - キーワード行があり日付が取れれば resolveDate
 * - キーワード行自体に日付が無い場合、直後の1〜2行を探索し、最初に有効な日付として
 *   解釈できた行を採用する（【応募期間】等のラベル行と実際の日付が別行に分かれている
 *   投稿形式に対応。URL行は誤認防止のため探索対象から除外する。2026-08、実データで確認）。
 * - キーワード行はあるが「未公開/後日/未定」等なら not_published
 */
function fieldDate(body: string, keywords: string[], post: string | null): ResolvedDate {
  const lines = body.split(/\n+/).map((l) => l.trim());
  const idx = lineIndexContaining(lines, keywords);
  if (idx === -1) return emptyResolved();
  const line = lines[idx];
  const rd = resolveDate(line, post);
  if (rd.precision !== "unknown") return rd;

  for (let offset = 1; offset <= 2; offset++) {
    const nextLine = lines[idx + offset];
    if (nextLine === undefined || looksLikeNonDateLine(nextLine)) continue;
    const nextResolved = resolveDate(nextLine, post);
    if (nextResolved.precision !== "unknown") return nextResolved;
  }

  if (hasAny(line, NOT_PUBLISHED_SIGNALS) || hasAny(body, NOT_PUBLISHED_SIGNALS)) {
    return { ...emptyResolved(), status: "not_published", rawText: line };
  }
  return { ...emptyResolved(), rawText: line };
}

function firstUrlOfType(urls: ClassifiedUrl[], type: ClassifiedUrl["urlType"]): string | null {
  return urls.find((u) => u.urlType === type)?.originalUrl ?? null;
}

/**
 * 先頭の店舗名らしき語を抽出（"<店舗>で..." / "<店舗>では..."）。
 * 店舗名中のスペースは除外しない（"BIGMAGIC 池袋店"・"Tokyo Otaku Mode"のように、実際の
 * 店舗名・ブランド名にスペースを含むケースが多いため、除外すると抽出自体が失敗してしまう。
 * 2026-08、実データで確認）。文字数上限も、長めの正式ブランド名（"ONE PIECEカードゲーム公式
 * ショップ"等）を拾えるよう20→40に広げた。
 */
function extractStoreName(body: string): string | null {
  const firstLine = body.split(/\n+/)[0] ?? "";
  const m = firstLine.match(/^\s*([^。、「」]{2,40}?)(?:で|では|にて)/);
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
  // パターン(1)・(2)はラベル節の中身（商品バリエーション列挙・手順説明等）を店舗として
  // 誤抽出しないよう、ラベル節を除いた本文を使う（パターン(0)は【】自体を見るため元の本文を使う）。
  const bodyWithoutLabelSections = stripLabelSections(body);
  const lines = bodyWithoutLabelSections.split(/\n+/);
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

  // 行から店舗名と（あれば）締切日付を取り出す（(0)(1)で共通利用）。
  const parseStoreAndDeadline = (line: string): { store: string | null; applicationEnd: ResolvedDate } => {
    const m = line.match(/^([^\d]+?)\s*([\d/].*)?$/);
    const store = (m ? m[1] : line).trim() || null;
    const dateText = m && m[2] ? m[2] : null;
    return { store, applicationEnd: dateText ? resolveDate(dateText, postPublishedAt) : emptyResolved() };
  };

  // (0) 【商品名】セクション区切り + 各セクション内にマーカー行が2つ以上（合計）→ セクションの
  // 商品名 × 行ごとの店舗で分割。「本日開始された抽選まとめ」のような、複数商品をそれぞれ
  // 【】見出しでグループ化し、各見出しの下に複数店舗を並べる投稿形式に対応する（2026-08、実データで確認）。
  // 【応募期間】【当選発表】のようにフィールドラベルとして【】を使う単一抽選投稿もあるため、
  // 既知のラベル語は商品名候補から除外する（該当セクション内に実際のマーカー行が無ければ
  // どのみち0件になり実害は無いが、意図を明確にするため明示的に除外する）。
  const sectionMatches = [...body.matchAll(/【([^】]{1,100})】([\s\S]*?)(?=【|$)/g)].filter(
    ([, header]) => !isSectionLabel(header.trim())
  );
  if (sectionMatches.length > 0) {
    const sectionResults: ExtractedLottery[] = [];
    for (const [, sectionProductRaw, sectionBody] of sectionMatches) {
      const sectionProduct = sectionProductRaw.trim() || null;
      const sectionMarkerLines = sectionBody.split(/\n+/).filter((l) => LIST_MARKER_PATTERN.test(l));
      for (const line of sectionMarkerLines) {
        const { store, applicationEnd } = parseStoreAndDeadline(stripListMarker(line));
        sectionResults.push(make(sectionProduct, store, applicationEnd));
      }
    }
    if (sectionResults.length >= 2) return sectionResults;
  }

  // (1) 店舗マーカー行が2つ以上 → 店舗ごとに分割
  // 各行が独自の「」商品名を持つ場合はそれを使用する（店舗ごとに商品が異なるまとめ投稿）。
  // 無ければ従来通りヘッダ商品を共通で使う。
  if (markerLines.length >= 2) {
    return markerLines.map((line) => {
      const rest = stripListMarker(line);
      const lineProduct = extractProductName(rest);
      const withoutProduct = lineProduct ? rest.replace(/[「『][^」』]{1,60}[」』]/, "").trim() : rest;
      const { store, applicationEnd } = parseStoreAndDeadline(withoutProduct);
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
