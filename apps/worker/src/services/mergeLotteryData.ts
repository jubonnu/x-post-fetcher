/**
 * 情報統合（Phase 3・純関数）。
 *
 * 方針（実装計画 §mergeLotteryData に準拠）:
 *  - 空欄は補完する（既存が空・新規に値あり → 採用）。
 *  - 競合（両方に値があり不一致）は **既存を壊さず両方保持の思想** で、既存値を維持し
 *    `verificationStatus = conflicting`・履歴 `conflicting` を記録する（低信頼で高信頼を上書きしない）。
 *  - 日付は precision で優先度を判断し、**高精度を低精度で上書きしない**。
 */

type Row = Record<string, string | number | boolean | null | undefined>;

export interface FieldChange {
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  changeType: "updated" | "conflicting";
}

export interface MergeResult {
  updates: Record<string, string | null>;
  changes: FieldChange[];
  verificationStatus: string;
  hasConflict: boolean;
}

const s = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t.length ? t : null;
};

const DATE_GROUPS = [
  { at: "applicationEndAt", date: "applicationEndDate", precision: "applicationEndPrecision" },
  { at: "resultAnnouncementAt", date: "resultAnnouncementDate", precision: "resultAnnouncementPrecision" },
] as const;

const SCALAR_FIELDS = [
  "productNameRaw",
  "normalizedProductName",
  "cardType",
  "storeNameRaw",
  "normalizedStoreName",
  "storeBranchRaw",
  "normalizedStoreBranch",
  "region",
  "applicationStartAt",
  "confirmedOpenAt",
  "purchaseStartAt",
  "purchaseDeadlineAt",
  "applicationUrl",
  "officialInformationUrl",
  "appDownloadUrl",
  "applicationMethod",
  "eligibilityConditions",
  "pickupMethod",
  "paymentMethod",
  "price",
] as const;

/** 日付精度のランク（高いほど確度が高い）。 */
function precisionRank(p: string | null): number {
  switch (p) {
    case "datetime":
      return 3;
    case "date_only":
    case "store_closing_time":
      return 2;
    case "inferred":
      return 1;
    default:
      return 0; // unknown / not_published / null
  }
}

/**
 * existing に incoming をマージした結果を返す（existing 自体は変更しない）。
 */
export function mergeLotteryData(existing: Row, incoming: Row): MergeResult {
  const updates: Record<string, string | null> = {};
  const changes: FieldChange[] = [];
  let hasConflict = false;

  const fill = (field: string, oldV: string | null, newV: string | null) => {
    updates[field] = newV;
    changes.push({ fieldName: field, oldValue: oldV, newValue: newV, changeType: "updated" });
  };
  const conflict = (field: string, oldV: string | null, newV: string | null) => {
    hasConflict = true;
    changes.push({ fieldName: field, oldValue: oldV, newValue: newV, changeType: "conflicting" });
  };

  // スカラー項目
  for (const f of SCALAR_FIELDS) {
    const oldV = s(existing[f]);
    const newV = s(incoming[f]);
    if (newV === null) continue; // 新規に情報なし
    if (oldV === null) fill(f, null, newV); // 空欄補完
    else if (oldV === newV) continue; // 同値
    else conflict(f, oldV, newV); // 競合 → 既存維持
  }

  // 日付グループ（precision で優先度判断）
  for (const g of DATE_GROUPS) {
    const oldPrec = s(existing[g.precision]);
    const newPrec = s(incoming[g.precision]);
    const oldAt = s(existing[g.at]);
    const oldDate = s(existing[g.date]);
    const newAt = s(incoming[g.at]);
    const newDate = s(incoming[g.date]);

    const newHasValue = newAt !== null || newDate !== null;
    const oldHasValue = oldAt !== null || oldDate !== null;
    if (!newHasValue) continue;

    if (!oldHasValue) {
      // 空欄補完（グループごと採用）
      updates[g.at] = newAt;
      updates[g.date] = newDate;
      updates[g.precision] = newPrec;
      changes.push({ fieldName: g.date, oldValue: null, newValue: newDate ?? newAt, changeType: "updated" });
      continue;
    }
    const rOld = precisionRank(oldPrec);
    const rNew = precisionRank(newPrec);
    if (rNew > rOld) {
      // 高精度で上書き
      updates[g.at] = newAt;
      updates[g.date] = newDate;
      updates[g.precision] = newPrec;
      changes.push({ fieldName: g.date, oldValue: oldDate ?? oldAt, newValue: newDate ?? newAt, changeType: "updated" });
    } else if (rNew < rOld) {
      // 低精度は破棄（高精度を壊さない）
      continue;
    } else {
      // 同精度で値が異なれば競合、同じならスキップ
      if (oldAt !== newAt || oldDate !== newDate) conflict(g.date, oldDate ?? oldAt, newDate ?? newAt);
    }
  }

  const existingStatus = s(existing.verificationStatus) ?? "extracted";
  const verificationStatus = hasConflict ? "conflicting" : existingStatus;
  return { updates, changes, verificationStatus, hasConflict };
}
