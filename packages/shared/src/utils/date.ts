import type { ResolvedDate } from "../schemas.ts";

/**
 * 日本語の日時表現を解決する（Phase 2）。
 *
 * - 年省略（M/D・M月D日）は投稿日時から推定し yearInferred=true
 * - 「閉店時間」は precision=store_closing_time（at は null、date のみ）
 * - 括弧内の曜日（例 (火)）が推定年と一致しない場合は status=conflicting
 * - 時刻ありは datetime、日付のみは date_only
 *
 * 投稿日時（postPublishedAt, ISO）は日本の投稿者基準で JST に変換して年推定に使う。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAY: Record<string, number> = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };

function emptyDate(rawText: string | null): ResolvedDate {
  return { at: null, date: null, precision: "unknown", status: "unknown", rawText, yearInferred: false };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** JST カレンダー上の年月日を取り出す */
function jstYmd(iso: string): { y: number; m: number; d: number } | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const j = new Date(t + JST_OFFSET_MS);
  return { y: j.getUTCFullYear(), m: j.getUTCMonth() + 1, d: j.getUTCDate() };
}

function weekdayOf(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function resolveDate(rawText: string | null | undefined, postPublishedAt: string | null): ResolvedDate {
  if (!rawText || !rawText.trim()) return emptyDate(rawText ?? null);
  const text = rawText.trim();

  // 明示的な年
  const yearMatch = text.match(/(\d{4})\s*年/);
  // 月日: 「M月D日」または「M/D」
  const mdKanji = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const mdSlash = text.match(/(?<!\d)(\d{1,2})\/(\d{1,2})(?!\d)/);
  const md = mdKanji ?? mdSlash;
  if (!md) return emptyDate(text);

  const month = Number(md[1]);
  const day = Number(md[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return emptyDate(text);

  // 括弧内の曜日のみ拾う（"8月" の 月 を曜日と誤認しない）
  const wdMatch = text.match(/[（(]\s*([日月火水木金土])\s*[)）]/);
  const weekday = wdMatch ? WEEKDAY[wdMatch[1]] : null;

  // 時刻
  const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
  const hasClosing = /閉店/.test(text);

  // 年の決定
  let year: number;
  let yearInferred = false;
  if (yearMatch) {
    year = Number(yearMatch[1]);
  } else {
    const post = postPublishedAt ? jstYmd(postPublishedAt) : null;
    if (post) {
      year = post.y;
      const cand = Date.UTC(year, month - 1, day);
      const postMid = Date.UTC(post.y, post.m - 1, post.d);
      // 投稿日より 2 日以上前になるなら翌年（締切は原則未来）
      if (cand < postMid - 2 * 86400000) year = post.y + 1;
      yearInferred = true;
    } else {
      // 投稿日時も無ければ推定不可
      return {
        at: null,
        date: `????-${pad(month)}-${pad(day)}`.replace("????-", "0000-"),
        precision: "unknown",
        status: "unknown",
        rawText: text,
        yearInferred: false,
      };
    }
  }

  const dateStr = `${year}-${pad(month)}-${pad(day)}`;
  let status: ResolvedDate["status"] = "extracted";

  // 曜日整合チェック（推定年と一致しなければ conflicting）
  if (weekday != null && weekdayOf(year, month, day) !== weekday) {
    status = "conflicting";
    yearInferred = true;
  }

  // 閉店時間: 時刻は確定できない
  if (hasClosing) {
    return { at: null, date: dateStr, precision: "store_closing_time", status, rawText: text, yearInferred };
  }

  // 時刻あり: datetime
  if (timeMatch) {
    const hh = pad(Number(timeMatch[1]));
    const mm = pad(Number(timeMatch[2]));
    return {
      at: `${dateStr}T${hh}:${mm}:00+09:00`,
      date: dateStr,
      precision: "datetime",
      status,
      rawText: text,
      yearInferred,
    };
  }

  // 日付のみ
  return { at: null, date: dateStr, precision: "date_only", status, rawText: text, yearInferred };
}
