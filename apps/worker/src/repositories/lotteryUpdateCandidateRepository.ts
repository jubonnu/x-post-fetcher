import { and, count, desc, eq } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/client.ts";
import {
  lotteries,
  lotteryFieldHistory,
  lotterySources,
  lotteryUpdateCandidates,
  type LotteryRow,
  type LotteryUpdateCandidateRow,
} from "../db/schema.ts";
import { DATE_GROUPS, SCALAR_FIELDS, mergeLotteryData, type FieldChange } from "../services/mergeLotteryData.ts";
import type { toLotteryRow } from "./lotteryRepository.ts";

/** `toLotteryRow` と同形（正規化済み商品名・店舗名を含む抽出済み抽選データ）。 */
export type LotteryCandidateData = ReturnType<typeof toLotteryRow>;

export interface UpsertLotteryUpdateCandidateInput {
  targetLotteryId: number;
  sourcePostId: number;
  candidateIndex: number;
  /**
   * `(sourcePostId, candidateKey)` の一意キー。呼び出し側（`syncLotteriesFromAnalysis`）が
   * 同一投稿内の商品名・店舗名の重複を考慮して一意化した上で渡す
   * （`services/lotteryUpdateCandidateKey.ts`の`buildLotteryUpdateCandidateKey`+
   * `disambiguateCandidateKey`）。この関数自体はキー生成に関与しない。
   */
  candidateKey: string;
  matchScore: number;
  matchReason: string;
  extractedData: LotteryCandidateData;
}

export type UpsertLotteryUpdateCandidateAction = "inserted" | "updated" | "skipped_resolved";

export interface UpsertLotteryUpdateCandidateResult {
  action: UpsertLotteryUpdateCandidateAction;
  id: number;
}

/**
 * 更新候補をUPSERTする（Phase 11）。
 * - 未存在 → 新規挿入（status=pending）。
 * - 既存でstatus=pending → 内容を最新化（同じ論理候補の再解析、または再マッチングでの
 *   targetLotteryId変化に追従する）。
 * - 既存でstatus!=pending（applied/registered_as_new/ignored=解決済み）→ 一切変更しない
 *   （解決済みの候補を再解析で復活させない、という明示要件）。
 *
 * `existingByKey`を渡した場合、`(sourcePostId, candidateKey)`一致行のSELECTを省略し、
 * その場でMapから引く（呼び出し元が同一sourcePostId分をループ開始前に1回だけ取得している前提。
 * summary投稿のように候補が数十件に及ぶ場合、候補ごとにSELECTするとCloudflare Workersの
 * subrequest上限に到達するため。2026-08、staging実データで実際に発生した障害の再発防止）。
 * 省略した場合は従来どおりDBへ都度問い合わせる。
 */
export async function upsertLotteryUpdateCandidate(
  db: DbOrTx,
  input: UpsertLotteryUpdateCandidateInput,
  existingByKey?: ReadonlyMap<string, LotteryUpdateCandidateRow>
): Promise<UpsertLotteryUpdateCandidateResult> {
  const candidateKey = input.candidateKey;

  let existing: LotteryUpdateCandidateRow | undefined;
  if (existingByKey) {
    existing = existingByKey.get(candidateKey);
  } else {
    const existingRows = await db
      .select()
      .from(lotteryUpdateCandidates)
      .where(
        and(
          eq(lotteryUpdateCandidates.sourcePostId, input.sourcePostId),
          eq(lotteryUpdateCandidates.candidateKey, candidateKey)
        )
      );
    existing = existingRows[0];
  }

  if (existing) {
    if (existing.status !== "pending") {
      return { action: "skipped_resolved", id: existing.id };
    }
    await db
      .update(lotteryUpdateCandidates)
      .set({
        targetLotteryId: input.targetLotteryId,
        candidateIndex: input.candidateIndex,
        matchScore: String(input.matchScore),
        matchReason: input.matchReason,
        extractedData: JSON.stringify(input.extractedData),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(lotteryUpdateCandidates.id, existing.id));
    return { action: "updated", id: existing.id };
  }

  const [inserted] = await db
    .insert(lotteryUpdateCandidates)
    .values({
      targetLotteryId: input.targetLotteryId,
      sourcePostId: input.sourcePostId,
      candidateIndex: input.candidateIndex,
      candidateKey,
      matchScore: String(input.matchScore),
      matchReason: input.matchReason,
      extractedData: JSON.stringify(input.extractedData),
      status: "pending",
    })
    .returning({ id: lotteryUpdateCandidates.id });
  return { action: "inserted", id: inserted.id };
}

export interface ListLotteryUpdateCandidatesOptions {
  status?: string;
  limit?: number;
  offset?: number;
}

export interface ListLotteryUpdateCandidatesResult {
  candidates: LotteryUpdateCandidateRow[];
  total: number;
}

/** 管理画面「更新候補」タブの一覧用（既定はstatus絞り込みなし＝全件、新しい順）。 */
export async function listLotteryUpdateCandidates(
  db: DbOrTx,
  opts: ListLotteryUpdateCandidatesOptions = {}
): Promise<ListLotteryUpdateCandidatesResult> {
  const { status, limit = 20, offset = 0 } = opts;
  const where = status ? eq(lotteryUpdateCandidates.status, status) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(lotteryUpdateCandidates)
      .where(where)
      .orderBy(desc(lotteryUpdateCandidates.createdAt))
      .limit(Math.min(limit, 100))
      .offset(offset),
    db.select({ total: count() }).from(lotteryUpdateCandidates).where(where),
  ]);

  return { candidates: rows, total };
}

export async function getLotteryUpdateCandidateById(db: DbOrTx, id: number): Promise<LotteryUpdateCandidateRow | null> {
  const rows = await db.select().from(lotteryUpdateCandidates).where(eq(lotteryUpdateCandidates.id, id));
  return rows[0] ?? null;
}

/** `merged.changes`に現れない（＝両方に値がありかつ同値の）フィールド名一覧。 */
function computeMatchingFields(
  target: Record<string, unknown>,
  incoming: Record<string, unknown>,
  changedFieldNames: Set<string>
): string[] {
  const sv = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const t = String(v).trim();
    return t.length ? t : null;
  };
  const matching: string[] = [];

  for (const f of SCALAR_FIELDS) {
    if (changedFieldNames.has(f)) continue;
    const a = sv(target[f]);
    const b = sv(incoming[f]);
    if (a !== null && b !== null && a === b) matching.push(f);
  }
  for (const g of DATE_GROUPS) {
    if (changedFieldNames.has(g.date)) continue;
    const a = sv(target[g.date]) ?? sv(target[g.at]);
    const b = sv(incoming[g.date]) ?? sv(incoming[g.at]);
    if (a !== null && b !== null && a === b) matching.push(g.date);
  }
  return matching;
}

export interface LotteryUpdateCandidateDiff {
  candidate: LotteryUpdateCandidateRow;
  /** targetLotteryが既に削除/統合済み等で見つからない場合はnull（管理画面側で「新規登録」のみ案内する）。 */
  targetLottery: LotteryRow | null;
  extractedData: LotteryCandidateData;
  /** 既存が空欄で新規に値がある（追加可能）フィールド。 */
  addableFields: FieldChange[];
  /** 既存・新規どちらにも値がありかつ異なる（競合）フィールド。 */
  conflictingFields: FieldChange[];
  /** 既存に値があり、新規の方が優先度が高い（日付精度）ため上書きになるフィールド。 */
  overwritableFields: FieldChange[];
  /** 既存・新規が一致しているフィールド名。 */
  matchingFields: string[];
}

/**
 * 更新候補の詳細（既存抽選との差分付き）を返す（管理画面の候補詳細画面用）。
 * 差分計算は`mergeLotteryData`をそのまま流用する（このラウンドでは自動書き込みには使わず、
 * 差分表示専用の純関数として再利用するのみ）。
 */
export async function getLotteryUpdateCandidateDiff(db: DbOrTx, id: number): Promise<LotteryUpdateCandidateDiff | null> {
  const candidate = await getLotteryUpdateCandidateById(db, id);
  if (!candidate) return null;

  const extractedData = JSON.parse(candidate.extractedData) as LotteryCandidateData;
  const targetRows = await db.select().from(lotteries).where(eq(lotteries.id, candidate.targetLotteryId));
  const targetLottery = targetRows[0] ?? null;

  if (!targetLottery) {
    return {
      candidate,
      targetLottery: null,
      extractedData,
      addableFields: [],
      conflictingFields: [],
      overwritableFields: [],
      matchingFields: [],
    };
  }

  const merged = mergeLotteryData(
    targetLottery as unknown as Record<string, string | null>,
    extractedData as unknown as Record<string, string | null>
  );
  const addableFields = merged.changes.filter((c) => c.changeType === "updated" && c.oldValue === null);
  const overwritableFields = merged.changes.filter((c) => c.changeType === "updated" && c.oldValue !== null);
  const conflictingFields = merged.changes.filter((c) => c.changeType === "conflicting");
  const matchingFields = computeMatchingFields(
    targetLottery as unknown as Record<string, unknown>,
    extractedData as unknown as Record<string, unknown>,
    new Set(merged.changes.map((c) => c.fieldName))
  );

  return { candidate, targetLottery, extractedData, addableFields, conflictingFields, overwritableFields, matchingFields };
}

export type ApplyLotteryUpdateCandidateError =
  | "candidate_not_found"
  | "candidate_already_resolved"
  | "target_lottery_not_found"
  | "no_fields_selected";

export interface ApplyLotteryUpdateCandidateResult {
  ok: true;
  targetLotteryId: number;
  appliedFields: string[];
}

/**
 * 管理者が選択したフィールドのみを既存抽選へ反映する（Phase 11）。
 * `mergeLotteryData`が計算した差分（addable/overwritable/conflicting）のうち、
 * `selectedFields`に含まれるものだけを書き込む。conflictingなフィールドを選択した場合は
 * 新しい値で明示的に上書きする（管理者の判断を最優先するため、既存維持のconflict保護ロジックは
 * ここでは適用しない）。
 */
export async function applyLotteryUpdateCandidate(
  db: Db,
  id: number,
  selectedFields: string[],
  resolvedBy: string
): Promise<ApplyLotteryUpdateCandidateResult | ApplyLotteryUpdateCandidateError> {
  if (selectedFields.length === 0) return "no_fields_selected";

  const diff = await getLotteryUpdateCandidateDiff(db, id);
  if (!diff) return "candidate_not_found";
  if (diff.candidate.status !== "pending") return "candidate_already_resolved";
  if (!diff.targetLottery) return "target_lottery_not_found";

  const selected = new Set(selectedFields);
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {};
  const historyEntries: FieldChange[] = [];

  // addable/overwritable: mergeLotteryDataのupdatesにある新しい値をそのまま採用する。
  for (const c of [...diff.addableFields, ...diff.overwritableFields]) {
    if (!selected.has(c.fieldName)) continue;
    const group = DATE_GROUPS.find((g) => g.date === c.fieldName);
    if (group) {
      const extracted = diff.extractedData as unknown as Record<string, unknown>;
      patch[group.at] = extracted[group.at] ?? null;
      patch[group.date] = extracted[group.date] ?? null;
      patch[group.precision] = extracted[group.precision] ?? null;
    } else {
      patch[c.fieldName] = c.newValue;
    }
    historyEntries.push(c);
  }
  // conflicting: 管理者が選択した場合のみ新しい値で明示的に上書きする。
  for (const c of diff.conflictingFields) {
    if (!selected.has(c.fieldName)) continue;
    const group = DATE_GROUPS.find((g) => g.date === c.fieldName);
    if (group) {
      const extracted = diff.extractedData as unknown as Record<string, unknown>;
      patch[group.at] = extracted[group.at] ?? null;
      patch[group.date] = extracted[group.date] ?? null;
      patch[group.precision] = extracted[group.precision] ?? null;
    } else {
      patch[c.fieldName] = c.newValue;
    }
    historyEntries.push({ ...c, changeType: "updated" });
  }

  if (Object.keys(patch).length === 0) return "no_fields_selected";

  const targetLotteryId = diff.targetLottery.id;
  await db.update(lotteries).set({ ...patch, updatedAt: now }).where(eq(lotteries.id, targetLotteryId));

  for (const h of historyEntries) {
    await db.insert(lotteryFieldHistory).values({
      lotteryId: targetLotteryId,
      sourcePostId: diff.candidate.sourcePostId,
      fieldName: h.fieldName,
      oldValue: h.oldValue,
      newValue: h.newValue,
      changeType: h.changeType,
    });
  }

  const appliedFields = historyEntries.map((h) => h.fieldName);
  await db
    .update(lotteryUpdateCandidates)
    .set({
      status: "applied",
      resolvedBy,
      resolvedAt: now,
      appliedFields: JSON.stringify(appliedFields),
      updatedAt: now,
    })
    .where(eq(lotteryUpdateCandidates.id, id));

  return { ok: true, targetLotteryId, appliedFields };
}

export type RegisterLotteryUpdateCandidateAsNewError = "candidate_not_found" | "candidate_already_resolved";

export interface RegisterLotteryUpdateCandidateAsNewResult {
  ok: true;
  lotteryId: number;
}

/** 管理者が「別抽選として新規登録」した場合。抽出済みデータをそのまま新規`lotteries`行として挿入する。 */
export async function registerLotteryUpdateCandidateAsNew(
  db: Db,
  id: number,
  resolvedBy: string
): Promise<RegisterLotteryUpdateCandidateAsNewResult | RegisterLotteryUpdateCandidateAsNewError> {
  const candidate = await getLotteryUpdateCandidateById(db, id);
  if (!candidate) return "candidate_not_found";
  if (candidate.status !== "pending") return "candidate_already_resolved";

  const extractedData = JSON.parse(candidate.extractedData) as LotteryCandidateData;
  const now = new Date().toISOString();
  const [insertedLottery] = await db
    .insert(lotteries)
    .values({ ...extractedData, sourcePostId: candidate.sourcePostId })
    .returning({ id: lotteries.id });

  await db.insert(lotterySources).values({
    lotteryId: insertedLottery.id,
    sourcePostId: candidate.sourcePostId,
    matchAction: "registered_as_new",
    matchScore: candidate.matchScore,
    matchReason: candidate.matchReason,
    contributedFields: null,
  });

  await db
    .update(lotteryUpdateCandidates)
    .set({
      status: "registered_as_new",
      resolvedBy,
      resolvedAt: now,
      registeredLotteryId: insertedLottery.id,
      updatedAt: now,
    })
    .where(eq(lotteryUpdateCandidates.id, id));

  return { ok: true, lotteryId: insertedLottery.id };
}

export type IgnoreLotteryUpdateCandidateError = "candidate_not_found" | "candidate_already_resolved";

/** 管理者が「無視」した場合。既存抽選には一切触れない。 */
export async function ignoreLotteryUpdateCandidate(
  db: Db,
  id: number,
  resolvedBy: string
): Promise<{ ok: true } | IgnoreLotteryUpdateCandidateError> {
  const candidate = await getLotteryUpdateCandidateById(db, id);
  if (!candidate) return "candidate_not_found";
  if (candidate.status !== "pending") return "candidate_already_resolved";

  const now = new Date().toISOString();
  await db
    .update(lotteryUpdateCandidates)
    .set({ status: "ignored", resolvedBy, resolvedAt: now, updatedAt: now })
    .where(eq(lotteryUpdateCandidates.id, id));

  return { ok: true };
}
