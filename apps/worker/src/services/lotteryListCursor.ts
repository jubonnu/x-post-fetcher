import { z } from "zod";
import { isParsableDate } from "../validation/limits.ts";

/**
 * GET /lotteries のキーセットページネーション用カーソル。
 * (priority, sortKey, id) は repositories/lotteryRepository.ts の CTE が算出した
 * ソートキーそのもの（ORDER BY と同じ3列）。asOf はステータス分類を固定した基準時刻で、
 * 後続ページ要求でも同じ asOf を渡すことを必須とする（異なる asOf との組み合わせは拒否する）。
 */
export interface LotteryListCursor {
  priority: number;
  sortKey: number;
  id: number;
  asOf: string;
}

const cursorPayloadSchema = z.object({
  priority: z.number().int().min(0).max(3),
  sortKey: z.number().finite(),
  id: z.number().int().positive(),
  asOf: z.string().refine(isParsableDate, "asOfの日時形式が不正です"),
});

export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCursorError";
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  // 素の base64（+ / =）が来ても許容はしない。cursor は本サービスが発行した base64url のみ受理する。
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new InvalidCursorError("cursorのbase64url形式が不正です");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeLotteryListCursor(cursor: LotteryListCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return toBase64Url(bytes);
}

/**
 * cursor文字列をデコード・検証する。base64化は難読化に過ぎず改ざん防止にはならないため、
 * 形式（JSON構造・型・値域）を必ず検証し、不正な値は例外にする（呼び出し側で400にする）。
 * asOfが要求パラメータのasOfと一致するかの確認は呼び出し側（ルート）の責務とする。
 */
export function decodeLotteryListCursor(raw: string): LotteryListCursor {
  const bytes = fromBase64Url(raw);

  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidCursorError("cursorの文字エンコーディングが不正です");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidCursorError("cursorのJSON形式が不正です");
  }

  const result = cursorPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidCursorError("cursorの内容が不正です");
  }
  return result.data;
}
