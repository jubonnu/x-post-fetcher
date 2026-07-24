import { resolveDate, type ClassifiedUrl, type ExtractedLottery, type ResolvedDate } from "@x-post/shared";
import { detectCardType } from "./classifyPost.ts";
import { NOT_PUBLISHED_SIGNALS } from "./keywords.ts";

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
