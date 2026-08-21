import { resolveDate, resolveDateRange, type ClassifiedUrl, type ExtractedLottery, type ResolvedDate, type ResolvedDateRange } from "@x-post/shared";
import { detectCardType } from "./classifyPost.ts";
import { NOT_PUBLISHED_SIGNALS } from "./keywords.ts";
import type { ExternalLink } from "../scraping/x/parseTweetDom.ts";

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
 * 日付フィールド（範囲対応）を抽出。
 * - キーワード行があり日付が取れれば resolveDateRange（「A〜B」なら開始・終了の両方、
 *   単一日付なら終了側のみでresolveDateと同じ結果）
 * - キーワード行自体に日付が無い場合、直後の1〜2行を探索し、最初に有効な日付として
 *   解釈できた行を採用する（【応募期間】等のラベル行と実際の日付が別行に分かれている
 *   投稿形式に対応。URL行は誤認防止のため探索対象から除外する。2026-08、実データで確認）。
 * - キーワード行はあるが「未公開/後日/未定」等なら not_published
 */
function fieldDateRange(body: string, keywords: string[], post: string | null): ResolvedDateRange {
  const lines = body.split(/\n+/).map((l) => l.trim());
  const idx = lineIndexContaining(lines, keywords);
  if (idx === -1) return { start: null, end: emptyResolved() };
  const line = lines[idx];
  const range = resolveDateRange(line, post);
  if (range.end.precision !== "unknown") return range;

  for (let offset = 1; offset <= 2; offset++) {
    const nextLine = lines[idx + offset];
    if (nextLine === undefined || looksLikeNonDateLine(nextLine)) continue;
    const nextRange = resolveDateRange(nextLine, post);
    if (nextRange.end.precision !== "unknown") return nextRange;
  }

  if (hasAny(line, NOT_PUBLISHED_SIGNALS) || hasAny(body, NOT_PUBLISHED_SIGNALS)) {
    return { start: null, end: { ...emptyResolved(), status: "not_published", rawText: line } };
  }
  return { start: null, end: { ...emptyResolved(), rawText: line } };
}

/**
 * 日付フィールドを抽出（単一値。範囲表記があっても最初に見つかった日付をそのまま返す）。
 * 【応募開始】等、「開始日そのもの」を明示するラベル向け。範囲の終了側を拾ってしまわないよう、
 * `fieldDateRange`（`.end`が範囲の終了側になる）とは意図的に別実装にしている。
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

/** 応募URLの近くに書かれがちな案内文言（優先度2: 文言近接によるURL採用）。 */
const APPLICATION_PROXIMITY_KEYWORDS = ["応募はこちら", "抽選受付", "応募ページ", "エントリー", "申し込み", "申込み", "申込"];

/**
 * 店舗名 → 公式ドメインの対応表（優先度3: allowlist外でも店舗公式ドメインなら採用）。
 * 誤爆を避けるため、店舗名に別名が部分一致した場合のみ対応ドメインを候補にする
 * （店舗名が無い/一致しない投稿には一切影響しない）。
 */
const STORE_OFFICIAL_DOMAINS: { aliases: string[]; domain: string }[] = [
  { aliases: ["駿河屋"], domain: "suruga-ya.jp" },
  { aliases: ["プレミアムバンダイ"], domain: "p-bandai.jp" },
  { aliases: ["エディオン"], domain: "edion-cp.com" },
  { aliases: ["コナミスタイル"], domain: "konamistyle.jp" },
  { aliases: ["DMM通販", "DMMマイカ"], domain: "dmm.com" },
  { aliases: ["晴れる屋"], domain: "hareruya2.com" },
  { aliases: ["ヨドバシ"], domain: "limited.yodobashi.com" },
  { aliases: ["楽天ブックス"], domain: "books.rakuten.co.jp" },
  { aliases: ["ジャンプショップ"], domain: "jumpshop-benelic.com" },
  { aliases: ["ミニストップ"], domain: "online.ministop.co.jp" },
  { aliases: ["イトーヨーカドー"], domain: "iyec.itoyokado.co.jp" },
];

/** 明らかに応募URLではない（SNS等の）ドメイン。優先度3/4のフォールバック候補から除外する。 */
const IRRELEVANT_DOMAIN_SUFFIXES = ["instagram.com", "youtube.com", "youtu.be", "tiktok.com", "facebook.com", "threads.net"];

function isIrrelevantDomain(domain: string): boolean {
  return IRRELEVANT_DOMAIN_SUFFIXES.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * 「未分類（urlType: unknown）」のURLのうち、応募URL候補として扱ってよいものだけを返す。
 * 既に app_download/image/x_post 等、他の種別に確定分類されているURLは対象外
 * （二重に応募URL扱いしてしまうと、例えばApp StoreリンクのみのケースでapplicationUrlに
 * 誤ってセットされてしまう。2026-08、実データ検証で確認）。
 */
function unknownUrlCandidates(urls: ClassifiedUrl[]): ClassifiedUrl[] {
  return urls.filter((u) => u.urlType === "unknown" && u.domain && !isIrrelevantDomain(u.domain));
}

/** キーワード行またはその直後1〜2行に、候補URLのドメインが登場するか探す。 */
function findUrlNearKeywords(candidates: ClassifiedUrl[], body: string, keywords: string[]): ClassifiedUrl | null {
  if (candidates.length === 0) return null;
  const lines = body.split(/\n+/);
  for (let i = 0; i < lines.length; i++) {
    if (!keywords.some((k) => lines[i].includes(k))) continue;
    for (let offset = 0; offset <= 2; offset++) {
      const line = lines[i + offset];
      if (line === undefined) continue;
      const match = candidates.find((u) => u.domain && line.includes(u.domain));
      if (match) return match;
    }
  }
  return null;
}

/** 店舗名が公式ドメイン対応表に一致するURLを探す。 */
function findUrlByStoreDomain(candidates: ClassifiedUrl[], storeNameRaw: string | null): ClassifiedUrl | null {
  if (!storeNameRaw) return null;
  const entry = STORE_OFFICIAL_DOMAINS.find((e) => e.aliases.some((alias) => storeNameRaw.includes(alias)));
  if (!entry) return null;
  return candidates.find((u) => u.domain === entry.domain) ?? null;
}

/**
 * 行が指定リンクの表示テキスト（例: "http://livepocket.jp/e/bpvrn"）を含むか判定する。
 * ClassifiedUrl（domainのみ保持）ではなく、生のリンクテキスト（パス込み）で照合する。
 * 同一ドメインの複数URLが並ぶケース（例: livepocket.jpの個別イベントURLが商品ごとに複数）で、
 * domainだけの判定だと全て同一URLとして扱われてしまうため（2026-08、sourcePostId=251で確認）。
 * 行末が省略記号（…）で切られている場合は前方一致でも許容する。
 */
function lineMatchesLinkText(line: string, linkText: string): boolean {
  if (!linkText) return false;
  if (line.includes(linkText)) return true;
  const truncatedLine = line.trim().replace(/…$/, "");
  return truncatedLine.length > 0 && (linkText.startsWith(truncatedLine) || truncatedLine.startsWith(linkText));
}

/**
 * 「【商品名】\nURL」のように、商品名の直後（同じ行〜2行以内）に個別の応募URLが
 * 書かれているケースで、その商品専用のURLを探す（複数商品まとめ投稿の商品ごと分割用）。
 * 見つからなければ null（呼び出し元は投稿全体で共有のapplicationUrlにフォールバックする）。
 * urlTypeによる絞り込みはしない（livepocket等allowlist一致のURLが商品ごとに複数並ぶケースが
 * 実データで多いため。2026-08、sourcePostId=251で確認: 6商品それぞれにlivepocket.jpの
 * 個別URLが振られていたが、ドメインだけで判定すると区別できず全商品に1件目のURLが
 * 誤って共有されていた）。
 */
/**
 * 「✅店舗名 日付〆\nURL」のように、マーカー行（店舗名）の直後（1〜2行以内）に個別の応募URLが
 * 書かれているケースで、その行専用のURLを探す（splitLotteriesの(0)(1)分岐で使用）。
 * 同一テキストの行が投稿内に複数回出現する場合（同じ店舗名が別商品セクションにも登場する等）に
 * 備え、`occurrence`（0始まり、呼び出し元が出現順に加算して渡す）で何回目の出現かを指定する。
 * 見つからなければ null（呼び出し元は投稿全体で共有のapplicationUrlにフォールバックする）。
 */
function findUrlAfterExactLine(links: ExternalLink[], bodyLines: string[], targetLine: string, occurrence: number): ExternalLink | null {
  const candidates = links.filter((l) => l.text);
  if (candidates.length === 0) return null;
  const trimmedTarget = targetLine.trim();
  let seen = 0;
  for (let i = 0; i < bodyLines.length; i++) {
    if (bodyLines[i].trim() !== trimmedTarget) continue;
    if (seen < occurrence) {
      seen++;
      continue;
    }
    for (let offset = 1; offset <= 2; offset++) {
      const line = bodyLines[i + offset];
      if (line === undefined) continue;
      const match = candidates.find((l) => lineMatchesLinkText(line, l.text));
      if (match) return match;
    }
    return null;
  }
  return null;
}

function findUrlNearProductOccurrence(links: ExternalLink[], lines: string[], productName: string): ExternalLink | null {
  const candidates = links.filter((l) => l.text);
  if (candidates.length === 0) return null;
  // 商品名の裸文字列ではなく「productName」/『productName』の引用符付きで探す。
  // 冒頭の見出し行（例:「A/B/Cの抽選開始」のように商品名を"/"区切りで列挙するだけの行）にも
  // 商品名の部分文字列が含まれてしまい、そちらに先に一致して本来のURL隣接行を
  // 見失うのを防ぐため（2026-08、sourcePostId=251で確認）。
  const quoted = [`「${productName}」`, `『${productName}』`];
  for (let i = 0; i < lines.length; i++) {
    if (!quoted.some((q) => lines[i].includes(q))) continue;
    for (let offset = 0; offset <= 2; offset++) {
      const line = lines[i + offset];
      if (line === undefined) continue;
      const match = candidates.find((l) => lineMatchesLinkText(line, l.text));
      if (match) return match;
    }
    return null;
  }
  return null;
}

export interface ApplicationUrlResolution {
  applicationUrl: string | null;
  /** 複数のURL候補があり、どれが応募URLか機械的に判別できなかった場合true（呼び出し元はneeds_reviewへ）。 */
  needsReview: boolean;
}

/**
 * 応募URL（applicationUrl）を、以下の優先順位で決定する（2026-08）。
 * 従来は classifyUrl() の allowlist（livepocket 等の主要抽選代行プラットフォーム）に
 * 完全一致しない限り常に null になっており、店舗が自社ドメインで応募ページを持つケース
 * （例: 駿河屋のブログ形式の応募ページ）でURLが消えてしまっていた。
 *
 *  1. allowlist（classifyUrl側で urlType:"application" と確定判定済み）→ 最優先
 *  2. 「応募はこちら」等の案内文言に近接するURL
 *  3. 店舗名から公式ドメインが一意に特定できるURL（STORE_OFFICIAL_DOMAINS）
 *  4. 上記に該当しないが、有効なURLが投稿内に1件だけ（画像/自己ツイート/SNS等を除く）→ フォールバック採用
 *  5. 複数件あり判別できない → applicationUrlは確定させず、呼び出し元でneeds_reviewにする
 *     （URL自体は失わない。extractedLotteries.urls経由で全件保持されたまま）
 */
export function resolveApplicationUrl(urls: ClassifiedUrl[], body: string): ApplicationUrlResolution {
  const allowlisted = firstUrlOfType(urls, "application");
  if (allowlisted) return { applicationUrl: allowlisted, needsReview: false };

  const candidates = unknownUrlCandidates(urls);

  const nearKeyword = findUrlNearKeywords(candidates, body, APPLICATION_PROXIMITY_KEYWORDS);
  if (nearKeyword) return { applicationUrl: nearKeyword.originalUrl, needsReview: false };

  const byStoreDomain = findUrlByStoreDomain(candidates, extractStoreName(body));
  if (byStoreDomain) return { applicationUrl: byStoreDomain.originalUrl, needsReview: false };

  if (candidates.length === 1) return { applicationUrl: candidates[0].originalUrl, needsReview: false };
  if (candidates.length >= 2) return { applicationUrl: null, needsReview: true };

  return { applicationUrl: null, needsReview: false };
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

  // 「A〜B」形式の範囲表記なら開始・終了の両方を拾う（応募期間・当選発表・購入期限、Phase 10）。
  // 開始日は、別ラベル（【応募開始】等）で明示されていればそちらを優先し、無ければ範囲表記から補う。
  const applicationStartExplicit = fieldDate(body, ["応募開始", "受付開始", "抽選開始日"], postPublishedAt);
  const applicationRange = fieldDateRange(body, ["応募期間", "締切", "〆", "まで"], postPublishedAt);
  const applicationEnd = applicationRange.end;
  const applicationStart =
    applicationStartExplicit.precision !== "unknown" ? applicationStartExplicit : applicationRange.start ?? applicationStartExplicit;

  const resultAnnouncementRange = fieldDateRange(body, ["当選発表", "当選者発表", "抽選結果"], postPublishedAt);
  const resultAnnouncement = resultAnnouncementRange.end;
  const resultAnnouncementStart = resultAnnouncementRange.start ?? emptyResolved();

  const purchaseStartExplicit = fieldDate(body, ["購入期間", "購入開始", "受取開始"], postPublishedAt);
  // 「購入期限」等に加え「購入期間」も範囲探索の対象にする（「【購入期間】A〜B」だけの投稿で
  // 締切側が拾えないままになっていたため。2026-08、実データで確認）。
  const purchaseDeadlineRange = fieldDateRange(body, ["購入期限", "受取期限", "支払期限", "購入期間"], postPublishedAt);
  const purchaseDeadline = purchaseDeadlineRange.end;
  const purchaseStart =
    purchaseStartExplicit.precision !== "unknown" ? purchaseStartExplicit : purchaseDeadlineRange.start ?? purchaseStartExplicit;

  // 「抽選開始されました」だけで開始日時が不明なら、投稿日時を confirmedOpenAt に保存
  const startedNow = /抽選開始されました|抽選開始しました|抽選が開始|受付開始しました/.test(body);
  const confirmedOpenAt = startedNow && applicationStart.precision === "unknown" ? postPublishedAt : null;

  const applicationUrl = resolveApplicationUrl(urls, body).applicationUrl;
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
    resultAnnouncementStart,
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
  urls: ClassifiedUrl[],
  externalLinks: ExternalLink[] = []
): ExtractedLottery[] | null {
  const body = bodyText ?? "";
  // パターン(1)・(2)はラベル節の中身（商品バリエーション列挙・手順説明等）を店舗として
  // 誤抽出しないよう、ラベル節を除いた本文を使う（パターン(0)は【】自体を見るため元の本文を使う）。
  const bodyWithoutLabelSections = stripLabelSections(body);
  const lines = bodyWithoutLabelSections.split(/\n+/);
  const markerLines = lines.filter((l) => LIST_MARKER_PATTERN.test(l));
  const headerProduct = extractHeaderProduct(body);

  const cardType = detectCardType(body);
  const resultAnnouncementRange = fieldDateRange(body, ["当選発表", "当選者発表", "抽選結果"], postPublishedAt);
  const resultAnnouncement = resultAnnouncementRange.end;
  const resultAnnouncementStart = resultAnnouncementRange.start ?? emptyResolved();
  const applicationUrl = resolveApplicationUrl(urls, body).applicationUrl;
  const officialInformationUrl = firstUrlOfType(urls, "official_information");
  const appDownloadUrl = firstUrlOfType(urls, "app_download");

  const make = (
    product: string | null,
    store: string | null,
    applicationEnd: ResolvedDate,
    applicationUrlOverride?: string | null
  ): ExtractedLottery => ({
    cardType,
    productNameRaw: product,
    storeNameRaw: store,
    storeBranchRaw: null,
    region: null,
    applicationStart: emptyResolved(),
    applicationEnd,
    resultAnnouncementStart,
    resultAnnouncement,
    purchaseStart: emptyResolved(),
    purchaseDeadline: emptyResolved(),
    confirmedOpenAt: null,
    applicationUrl: applicationUrlOverride !== undefined ? applicationUrlOverride : applicationUrl,
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
  // (0)(1)共通: マーカー行の直後にある個別URLを優先して割り当てる。同一テキストの行が
  // 複数回登場する場合に備え、出現順を数える（2026-08、sourcePostId=149のような
  // 「【商品名】セクションごとに✅店舗＋直後URLが複数並ぶ」投稿で、全店舗に同じURLが
  // 誤って割り当てられていた不具合の修正。sourcePostId=251の(2)分岐修正では未対応だった）。
  const fullBodyLines = body.split(/\n+/);
  const markerLineOccurrence = new Map<string, number>();
  const nextOccurrence = (line: string): number => {
    const n = markerLineOccurrence.get(line) ?? 0;
    markerLineOccurrence.set(line, n + 1);
    return n;
  };

  if (sectionMatches.length > 0) {
    const sectionResults: ExtractedLottery[] = [];
    for (const [, sectionProductRaw, sectionBody] of sectionMatches) {
      const sectionProduct = sectionProductRaw.trim() || null;
      const sectionMarkerLines = sectionBody.split(/\n+/).filter((l) => LIST_MARKER_PATTERN.test(l));
      for (const line of sectionMarkerLines) {
        const { store, applicationEnd } = parseStoreAndDeadline(stripListMarker(line));
        const perItemUrl = findUrlAfterExactLine(externalLinks, fullBodyLines, line, nextOccurrence(line));
        sectionResults.push(make(sectionProduct, store, applicationEnd, perItemUrl?.href));
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
      const perItemUrl = findUrlAfterExactLine(externalLinks, fullBodyLines, line, nextOccurrence(line));
      return make(lineProduct ?? headerProduct, store, applicationEnd, perItemUrl?.href);
    });
  }

  // (2) 商品「」が2つ以上 + 共通店舗 → 商品ごとに分割
  const products = [...body.matchAll(/[「『]([^」』]{1,60})[」』]/g)].map((x) => x[1]);
  const uniqueProducts = [...new Set(products)];
  const store = extractStoreName(body);
  if (uniqueProducts.length >= 2 && store) {
    const applicationEnd = fieldDate(body, ["応募期間", "締切", "〆", "まで"], postPublishedAt);
    // 商品ごとに直後（同じ行〜2行以内）に書かれた個別URLを優先して割り当てる。
    // 見つからなければ投稿全体で共有のapplicationUrl（resolveApplicationUrl側の判定）にフォールバックする
    // （「商品名の直後に個別の応募URLが列挙されている」投稿で、全商品に同じURLが誤って
    // 割り当てられてしまっていたため。2026-08、実データ sourcePostId=251 で確認・修正）。
    const bodyLines = body.split(/\n+/);
    return uniqueProducts.map((p) => {
      const perItemUrl = findUrlNearProductOccurrence(externalLinks, bodyLines, p);
      return make(p, store, applicationEnd, perItemUrl?.href);
    });
  }

  return null;
}
