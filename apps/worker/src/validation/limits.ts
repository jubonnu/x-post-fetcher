/**
 * Mobile-G2B（ユーザーデータ同期基盤）全体で共有する入力制限の定数。
 * すべて「まず保守的な値にしておき、実運用で必要になれば緩める」方針（10章要件）。
 */

export const PAGINATION_MAX_LIMIT = 100;
export const PAGINATION_DEFAULT_LIMIT = 20;

export const CHECKLIST_MAX_STEPS_PER_LOTTERY = 30;
export const CHECKLIST_LABEL_MAX_LENGTH = 200;
export const CHECKLIST_NOTE_MAX_LENGTH = 2000;
export const CHECKLIST_MAX_ITEMS_PER_PUT = 30;

export const QUIET_HOURS_TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
export const REMINDER_HOURS_BEFORE_MIN = 0;
export const REMINDER_HOURS_BEFORE_MAX = 168;

/** 初回一括同期（POST /me/sync/bootstrap）の配列ごとの最大件数。 */
export const SYNC_MAX_ITEMS_PER_ARRAY = 500;
/** リクエストボディ全体の最大バイト数（512KB）。 */
export const SYNC_MAX_PAYLOAD_BYTES = 512 * 1024;

/** clientRequestId/deviceId/batchClientRequestId は UUID形式のみ許可する。 */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isParsableDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}
