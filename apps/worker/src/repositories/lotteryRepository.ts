import { and, asc, count, desc, eq, getTableColumns, gte, inArray, isNull, like, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { ExtractedLottery } from "@x-post/shared";
import type { Db, DbOrTx } from "../db/client.ts";
import {
  lotteries,
  lotteryFieldHistory,
  lotterySources,
  sourcePosts,
  type LotteryRow,
  type LotterySourceRow,
  type LotteryFieldHistoryRow,
} from "../db/schema.ts";
import { encodeLotteryListCursor, type LotteryListCursor } from "../services/lotteryListCursor.ts";
import {
  NORMALIZER_VERSION,
  normalizeProductName,
  normalizeStoreBranch,
  normalizeStoreName,
} from "../services/normalize.ts";
import { matchExistingLottery, type MatchOptions } from "../services/matchExistingLottery.ts";
import { mergeLotteryData, type FieldChange } from "../services/mergeLotteryData.ts";
import { enqueueJob } from "./processingJobRepository.ts";

/**
 * approved 状態を needs_review に降格させる「重要フィールド」セット。
 * このフィールドに conflicting な変更がある場合のみ approved → needs_review となる。
 * 空欄補完・非競合更新・同一内容では approved を維持する。
 */
const APPROVED_CONFLICT_FIELDS = new Set([
  "productNameRaw", "normalizedProductName",
  "storeNameRaw", "normalizedStoreName",
  "storeBranchRaw", "normalizedStoreBranch",
  "applicationStartAt",
  "applicationEndDate",      // DATE_GROUPS は g.date のフィールド名で記録される
  "resultAnnouncementDate",  // 同上
  "purchaseDeadlineAt",
  "applicationUrl",
]);

/** 重要フィールドに競合（conflicting）な変更があるか判定する。 */
function hasImportantFieldConflict(changes: FieldChange[]): boolean {
  return changes.some((c) => c.changeType === "conflicting" && APPROVED_CONFLICT_FIELDS.has(c.fieldName));
}

/** completenessScore（0-1）: 商品/店舗=必須, 締切/当選/URL=重要 */
function completeness(l: ExtractedLottery): number {
  let s = 0;
  if (l.productNameRaw) s += 0.25;
  if (l.storeNameRaw) s += 0.25;
  if (l.applicationEnd.at || l.applicationEnd.date) s += 0.2;
  if (l.resultAnnouncement.at || l.resultAnnouncement.date) s += 0.15;
  if (l.applicationUrl) s += 0.15;
  return Number(s.toFixed(2));
}

/** 日時項目に conflicting があれば verificationStatus=conflicting */
function verification(l: ExtractedLottery): string {
  const fields = [l.applicationStart, l.applicationEnd, l.resultAnnouncement, l.purchaseStart, l.purchaseDeadline];
  return fields.some((f) => f.status === "conflicting") ? "conflicting" : "extracted";
}

/** 応募ページURLの配列をDB保存用のJSON文字列へ（空配列/未指定はnull）。 */
function serializeApplicationUrls(urls: string[] | null | undefined): string | null {
  if (!urls || urls.length === 0) return null;
  return JSON.stringify(urls);
}

/** DB保存されたJSON文字列を応募ページURLの配列へ（不正/未設定はnull）。 */
export function parseApplicationUrls(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((v) => typeof v === "string") ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * レスポンス用に`applicationUrls`をJSON文字列から配列へ変換した行を返す（DB上はJSON文字列のまま、
 * API応答でだけ配列にする。公開API・管理API共通）。
 */
export function withParsedApplicationUrls<T extends { applicationUrls: string | null }>(
  row: T
): Omit<T, "applicationUrls"> & { applicationUrls: string[] | null } {
  return { ...row, applicationUrls: parseApplicationUrls(row.applicationUrls) };
}

/** ExtractedLottery を lotteries 行（正規化込み）へ変換する。 */
export function toLotteryRow(sourcePostId: number, l: ExtractedLottery) {
  return {
    sourcePostId,
    productNameRaw: l.productNameRaw,
    normalizedProductName: normalizeProductName(l.productNameRaw),
    cardType: l.cardType,
    storeNameRaw: l.storeNameRaw,
    normalizedStoreName: normalizeStoreName(l.storeNameRaw),
    storeBranchRaw: l.storeBranchRaw,
    normalizedStoreBranch: normalizeStoreBranch(l.storeBranchRaw),
    region: l.region,
    normalizerVersion: NORMALIZER_VERSION,
    applicationStartAt: l.applicationStart.at ?? l.confirmedOpenAt,
    confirmedOpenAt: l.confirmedOpenAt,
    applicationEndAt: l.applicationEnd.at,
    applicationEndDate: l.applicationEnd.date,
    applicationEndPrecision: l.applicationEnd.precision,
    resultAnnouncementAt: l.resultAnnouncement.at,
    resultAnnouncementDate: l.resultAnnouncement.date,
    resultAnnouncementPrecision: l.resultAnnouncement.precision,
    purchaseStartAt: l.purchaseStart.at,
    purchaseDeadlineAt: l.purchaseDeadline.at ?? l.purchaseDeadline.date,
    applicationUrl: l.applicationUrl,
    applicationUrls: serializeApplicationUrls(l.applicationUrl ? [l.applicationUrl] : null),
    officialInformationUrl: l.officialInformationUrl,
    appDownloadUrl: l.appDownloadUrl,
    applicationMethod: l.applicationMethod,
    eligibilityConditions: l.eligibilityConditions,
    pickupMethod: l.pickupMethod,
    paymentMethod: l.paymentMethod,
    price: l.price,
    status: "open",
    completenessScore: String(completeness(l)),
    verificationStatus: verification(l),
  };
}

export interface LotteryActionResult {
  lotteryId: number;
  matchAction: string;
  matchScore: number;
  changedFields: string[];
}

export interface SyncLotteriesResult {
  count: number;
  merged: number;
  inserted: number;
  review: number;
  results: LotteryActionResult[];
}

/** 締切ブロック日数を環境変数から取得（既定は matchExistingLottery 側の 7 日）。 */
function matchOpts(): MatchOptions {
  const d = Number(process.env.MATCH_DEADLINE_BLOCK_DAYS);
  return Number.isFinite(d) && d > 0 ? { deadlineBlockDays: d } : {};
}

/** 新規 lottery 挿入時に「created」履歴を残す主要フィールド */
const CREATED_HISTORY_FIELDS: (keyof ReturnType<typeof toLotteryRow>)[] = [
  "normalizedProductName",
  "normalizedStoreName",
  "normalizedStoreBranch",
  "region",
  "applicationEndDate",
  "resultAnnouncementDate",
  "applicationUrl",
];

/**
 * この sourcePost がかつて寄与した抽選への貢献（sources / history）を取り消し、
 * 孤立した（どの source も残らない）抽選を sofft-delete（lifecycleStatus=orphaned）にする。
 * 物理削除は行わない。
 */
async function unlinkSourceContributions(db: Db, sourcePostId: number): Promise<void> {
  const prior = await db
    .select({ lotteryId: lotterySources.lotteryId })
    .from(lotterySources)
    .where(eq(lotterySources.sourcePostId, sourcePostId));
  const touchedIds = [...new Set(prior.map((r) => r.lotteryId))];

  await db.delete(lotterySources).where(eq(lotterySources.sourcePostId, sourcePostId));
  await db.delete(lotteryFieldHistory).where(eq(lotteryFieldHistory.sourcePostId, sourcePostId));

  if (touchedIds.length === 0) return;
  const remaining = await db
    .select({ lotteryId: lotterySources.lotteryId })
    .from(lotterySources)
    .where(inArray(lotterySources.lotteryId, touchedIds));
  const stillLinked = new Set(remaining.map((r) => r.lotteryId));
  const orphaned = touchedIds.filter((id) => !stillLinked.has(id));
  if (orphaned.length > 0) {
    const now = new Date().toISOString();
    await db
      .update(lotteries)
      .set({ lifecycleStatus: "orphaned", orphanedAt: now, updatedAt: now })
      .where(inArray(lotteries.id, orphaned));
  }
}

/**
 * 解析結果の抽選候補群を、同一抽選マッチング（match → merge / insert）で永続化する。
 * - merge: 既存抽選へ空欄補完・競合フラグ、`lottery_field_history` と `lottery_sources` を記録。
 * - new:   新規 `lotteries` 挿入 + created 履歴 + source。
 * - review: 新規挿入だが `verificationStatus = needs_review`（両方保持・要確認）。
 */
export async function syncLotteriesFromAnalysis(
  db: Db,
  sourcePostId: number,
  candidates: ReturnType<typeof toLotteryRow>[]
): Promise<SyncLotteriesResult> {
  await unlinkSourceContributions(db, sourcePostId);

  const result: SyncLotteriesResult = { count: 0, merged: 0, inserted: 0, review: 0, results: [] };
  const opts = matchOpts();

  for (const candidate of candidates) {
    const existing: LotteryRow[] = await db.select().from(lotteries);
    const m = matchExistingLottery(candidate, existing, opts);

    if (m.action === "merge" && m.matchedIndex !== null) {
      const target = existing[m.matchedIndex];

      // rejected は自動取込で一切変更しない
      if (target.verificationStatus === "rejected") {
        continue;
      }

      const merged = mergeLotteryData(target as unknown as Record<string, string | null>, candidate as unknown as Record<string, string | null>);
      // approved は「重要フィールドへの競合」がある場合のみ needs_review に降格する。
      // 同一内容・空欄補完・非重要フィールドの更新では approved を維持する。
      // approvedBy / approvedAt は競合時も監査情報として維持する（SET 句に含めない）。
      const newVerificationStatus =
        target.verificationStatus === "approved"
          ? hasImportantFieldConflict(merged.changes) ? "needs_review" : "approved"
          : merged.verificationStatus;
      // orphaned lottery が再び source と一致したら active に戻す（rejected 以外）
      const lifecycleUpdate =
        target.lifecycleStatus !== "active" ? { lifecycleStatus: "active", orphanedAt: null } : {};

      const needsUpdate =
        Object.keys(merged.updates).length > 0 ||
        merged.hasConflict ||
        Object.keys(lifecycleUpdate).length > 0 ||
        newVerificationStatus !== target.verificationStatus;

      if (needsUpdate) {
        await db
          .update(lotteries)
          .set({ ...merged.updates, verificationStatus: newVerificationStatus, ...lifecycleUpdate, updatedAt: new Date().toISOString() })
          .where(eq(lotteries.id, target.id));
      }
      for (const c of merged.changes) {
        await db.insert(lotteryFieldHistory).values({
          lotteryId: target.id,
          sourcePostId,
          fieldName: c.fieldName,
          oldValue: c.oldValue,
          newValue: c.newValue,
          changeType: c.changeType,
        });
      }
      await db.insert(lotterySources).values({
        lotteryId: target.id,
        sourcePostId,
        matchAction: "merge",
        matchScore: String(m.score),
        matchReason: m.reason,
        contributedFields: JSON.stringify(merged.changes.map((c) => c.fieldName)),
      });
      // URL 解決ジョブをエンキュー（applicationUrl がある場合のみ）
      const mergedUrl = (merged.updates as Record<string, unknown>).applicationUrl ?? target.applicationUrl;
      if (mergedUrl) await enqueueJob(db, "resolve_urls", { lotteryId: target.id });
      result.results.push({
        lotteryId: target.id,
        matchAction: "merge",
        matchScore: m.score,
        changedFields: merged.changes.map((c) => c.fieldName),
      });
      result.merged++;
    } else {
      const isReview = m.action === "review";
      const row = { ...candidate, verificationStatus: isReview ? "needs_review" : candidate.verificationStatus };
      const [inserted] = await db.insert(lotteries).values(row).returning({ id: lotteries.id });
      const lotteryId = inserted.id;
      for (const f of CREATED_HISTORY_FIELDS) {
        const v = candidate[f];
        if (v != null && String(v).length > 0) {
          await db.insert(lotteryFieldHistory).values({
            lotteryId,
            sourcePostId,
            fieldName: f,
            oldValue: null,
            newValue: String(v),
            changeType: "created",
          });
        }
      }
      await db.insert(lotterySources).values({
        lotteryId,
        sourcePostId,
        matchAction: m.action,
        matchScore: String(m.score),
        matchReason: m.reason,
        contributedFields: JSON.stringify(CREATED_HISTORY_FIELDS.filter((f) => candidate[f] != null)),
      });
      // URL 解決ジョブをエンキュー（applicationUrl がある場合のみ）
      if (candidate.applicationUrl) await enqueueJob(db, "resolve_urls", { lotteryId });
      result.results.push({
        lotteryId,
        matchAction: m.action,
        matchScore: m.score,
        changedFields: CREATED_HISTORY_FIELDS.filter((f) => candidate[f] != null),
      });
      if (isReview) result.review++;
      else result.inserted++;
    }
    result.count++;
  }

  return result;
}

// ---- Phase 5: 公開/管理 API 用クエリ ----

/**
 * 日付のみ（application_end_date / result_announcement_date）の値を、JSTの日付境界
 * （その日の23:59:59.999 JSTまで受付中、翌日0:00:00 JSTからended）として解釈するためのオフセット。
 * UTC 0時（＝日付のみの値のunixepoch()）から起算して、この秒数を足すとJSTでの翌日0時になる
 * （Asia/TokyoはDSTが無く常にUTC+9のため、24-9=15時間固定）。
 *
 * CardHubモバイル側 `apps/mobile/utils/time.ts` の `normalizeDeadline` と同一のルールであり、
 * 両者は必ず同期させること（どちらかだけを変更すると、一覧の並び順・ステータス判定が
 * サーバー/クライアントでズレる）。ズレは `tests/lotteries.test.ts` の境界値テストで検知できる。
 */
const JST_DATE_ONLY_END_OF_DAY_OFFSET_SECONDS = (24 - 9) * 60 * 60; // 54000

/**
 * application_end_at（あれば優先）/ application_end_date（日付のみ）から、
 * 「受付終了時刻」をUNIXエポック秒で算出するSQL式。at値が無く日付のみの場合、
 * 上記のJST日付境界オフセットを加算する。両方無ければNULL（＝日時未設定）。
 */
function endAtEpochExpr(atCol: AnySQLiteColumn, dateCol: AnySQLiteColumn): SQL<number | null> {
  return sql<number | null>`CASE
    WHEN ${atCol} IS NOT NULL THEN unixepoch(${atCol})
    WHEN ${dateCol} IS NOT NULL THEN unixepoch(${dateCol}) + ${JST_DATE_ONLY_END_OF_DAY_OFFSET_SECONDS}
    ELSE NULL
  END`;
}

export interface ListLotteriesOptions {
  cardType?: string;
  verificationStatus?: string;
  limit?: number;
  /** キーセットページネーションの開始位置。null/undefinedなら先頭ページ。 */
  cursor?: LotteryListCursor | null;
  /**
   * ステータス分類（受付中/結果待ち/終了済み）を固定する基準時刻（ISO8601）。
   * 保証するのは「時間経過によるステータス分類がページをまたいで変わらないこと」のみで、
   * データの追加・更新・削除に対する完全なスナップショットは保証しない
   * （ページ取得の合間に新規/更新された抽選は、次ページの結果に反映されうる）。
   */
  asOf: string;
}

export interface ListLotteriesResult {
  lotteries: LotteryRow[];
  total: number;
  /** 次ページが無い場合はnull。 */
  nextCursor: string | null;
}

/** 公開 GET /lotteries 用の一覧取得（キーセットページネーション + フィルタ）。
 * デフォルトで rejected + orphaned/archived を除外する。
 *
 * 並び順は 受付中 → 結果待ち → 終了済み → 日時未設定 の4段階（priority 0〜3）。
 * 同一priority内は 受付中=締切昇順 / 結果待ち=発表日昇順 / 終了済み=終了日時降順
 * （sortKeyの符号を反転して表現し、ORDER BYはpriority/sortKeyともASC統一にする）。
 * 日時未設定はsortKey=0固定で、id昇順のみで安定的に順序付けする
 * （アプリ側 `utils/publicLotteryDisplay.ts` の取得順維持とは異なるが、サーバーの
 * キーセットページネーションは全行に厳密な全順序が必要なため、この点のみ意図的に簡略化する）。
 *
 * priority/sortKeyはCTE（`prioritized`）で一度だけ算出し、カーソル条件・ORDER BYの両方が
 * その列を名前で参照する（CASE式を複数箇所に重複させない）。
 */
export async function listLotteries(db: DbOrTx, opts: ListLotteriesOptions): Promise<ListLotteriesResult> {
  const { cardType, verificationStatus, cursor = null, asOf } = opts;
  const limit = Math.min(Math.max(Number.isFinite(opts.limit) ? (opts.limit as number) : 20, 1), 100);
  const nowEpoch = Math.floor(new Date(asOf).getTime() / 1000);

  const conditions = [
    // rejected は公開しない
    ne(lotteries.verificationStatus, "rejected"),
    // orphaned / archived は公開しない
    eq(lotteries.lifecycleStatus, "active"),
    ...(cardType ? [eq(lotteries.cardType, cardType)] : []),
    ...(verificationStatus ? [eq(lotteries.verificationStatus, verificationStatus)] : []),
  ];
  const where = and(...conditions);

  // CTE 1: 終了/発表時刻をエポック秒に正規化する（生SQLの重複を避けるための中間列）。
  const classified = db.$with("classified").as(
    db
      .select({
        id: lotteries.id,
        endEpoch: endAtEpochExpr(lotteries.applicationEndAt, lotteries.applicationEndDate).as("end_epoch"),
        announceEpoch: endAtEpochExpr(lotteries.resultAnnouncementAt, lotteries.resultAnnouncementDate).as(
          "announce_epoch"
        ),
      })
      .from(lotteries)
      .where(where)
  );

  // CTE 2: priority/sortKeyを算出する。カーソル条件・ORDER BYはこのCTEの列だけを参照する。
  const prioritized = db.$with("prioritized").as(
    db
      .select({
        id: classified.id,
        priority: sql<number>`CASE
          WHEN ${classified.endEpoch} IS NULL THEN 3
          WHEN ${classified.endEpoch} > ${nowEpoch} THEN 0
          WHEN ${classified.announceEpoch} IS NOT NULL AND ${classified.announceEpoch} > ${nowEpoch} THEN 1
          ELSE 2
        END`.as("priority"),
        sortKey: sql<number>`CASE
          WHEN ${classified.endEpoch} IS NULL THEN 0
          WHEN ${classified.endEpoch} > ${nowEpoch} THEN ${classified.endEpoch}
          WHEN ${classified.announceEpoch} IS NOT NULL AND ${classified.announceEpoch} > ${nowEpoch} THEN ${classified.announceEpoch}
          ELSE -COALESCE(${classified.announceEpoch}, ${classified.endEpoch})
        END`.as("sort_key"),
      })
      .from(classified)
  );

  const cursorCondition = cursor
    ? sql`(${prioritized.priority}, ${prioritized.sortKey}, ${prioritized.id}) > (${cursor.priority}, ${cursor.sortKey}, ${cursor.id})`
    : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .with(classified, prioritized)
      .select({
        ...getTableColumns(lotteries),
        priority: prioritized.priority,
        sortKey: prioritized.sortKey,
      })
      .from(prioritized)
      .innerJoin(lotteries, eq(lotteries.id, prioritized.id))
      .where(cursorCondition)
      .orderBy(asc(prioritized.priority), asc(prioritized.sortKey), asc(prioritized.id))
      // 次ページの有無を判定するため1件多く取得する
      .limit(limit + 1),
    db.select({ total: count() }).from(lotteries).where(where),
  ]);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];

  const nextCursor =
    hasMore && last ? encodeLotteryListCursor({ priority: last.priority, sortKey: last.sortKey, id: last.id, asOf }) : null;

  return {
    lotteries: pageRows.map(({ priority: _priority, sortKey: _sortKey, ...rest }) => rest as LotteryRow),
    total,
    nextCursor,
  };
}

export interface ListLotteriesByOffsetOptions {
  cardType?: string;
  verificationStatus?: string;
  limit?: number;
  offset?: number;
}

export interface ListLotteriesByOffsetResult {
  lotteries: LotteryRow[];
  total: number;
}

/**
 * 内部管理画面（`/internal/review-items`）専用の単純なoffsetページネーション。
 * 公開一覧（`listLotteries`）の受付中/結果待ち/終了済みソートとは無関係に、
 * 作成日時降順で確認待ちの抽選を並べるだけでよいため、キーセットページネーションは適用しない。
 */
export async function listLotteriesByOffset(
  db: DbOrTx,
  opts: ListLotteriesByOffsetOptions = {}
): Promise<ListLotteriesByOffsetResult> {
  const { cardType, verificationStatus, limit = 20, offset = 0 } = opts;

  const conditions = [
    ne(lotteries.verificationStatus, "rejected"),
    eq(lotteries.lifecycleStatus, "active"),
    ...(cardType ? [eq(lotteries.cardType, cardType)] : []),
    ...(verificationStatus ? [eq(lotteries.verificationStatus, verificationStatus)] : []),
  ];
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(lotteries)
      .where(where)
      .orderBy(desc(lotteries.createdAt))
      .limit(Math.min(limit, 100))
      .offset(offset),
    db.select({ total: count() }).from(lotteries).where(where),
  ]);

  return { lotteries: rows, total };
}

export interface LotteryWithDetails {
  lottery: LotteryRow;
  sources: LotterySourceRow[];
  fieldHistory: LotteryFieldHistoryRow[];
}

/** 指定したlotteryIdが存在するか（Mobile-G2B-2: /me/lotteries系の所有者データ登録前チェック用）。 */
export async function lotteryExists(db: DbOrTx, lotteryId: number): Promise<boolean> {
  const rows = await db.select({ id: lotteries.id }).from(lotteries).where(eq(lotteries.id, lotteryId));
  return rows.length > 0;
}

/** 抽選の詳細（lottery_sources + lottery_field_history 付き）を取得する。 */
export async function getLotteryWithDetails(db: DbOrTx, id: number): Promise<LotteryWithDetails | null> {
  const rows = await db.select().from(lotteries).where(eq(lotteries.id, id));
  if (rows.length === 0) return null;

  const [sources, fieldHistory] = await Promise.all([
    db.select().from(lotterySources).where(eq(lotterySources.lotteryId, id)).orderBy(asc(lotterySources.createdAt)),
    db
      .select()
      .from(lotteryFieldHistory)
      .where(eq(lotteryFieldHistory.lotteryId, id))
      .orderBy(asc(lotteryFieldHistory.createdAt)),
  ]);

  return { lottery: rows[0], sources, fieldHistory };
}

export interface ListLotteriesForAdminOptions {
  verificationStatus?: string;
  /**
   * 指定した値**以外**（NULLも含む）を対象にする（管理画面の「要確認」タブ用）。
   * `verificationStatus`と同時指定した場合はこちらを優先する。
   */
  excludeVerificationStatuses?: string[];
  /**
   * 商品名・店舗名（raw/正規化どちらも）への部分一致検索（管理画面の「重複として統合」で
   * 統合先を探すためのもの、Phase 8）。
   */
  search?: string;
  /** 元投稿がXに投稿された日時（sourcePosts.publishedAt）での絞り込み。ISO8601、境界含む。 */
  sourcePostPublishedAtFrom?: string;
  sourcePostPublishedAtTo?: string;
  limit?: number;
  offset?: number;
}

/** 管理画面の抽選行（`LotteryRow`に加え、元投稿がXに投稿された日時を持つ）。 */
export interface AdminLotteryRow extends LotteryRow {
  sourcePostPublishedAt: string | null;
}

export interface ListLotteriesForAdminResult {
  lotteries: AdminLotteryRow[];
  total: number;
}

/**
 * 管理画面（Phase 7）の一覧用。`listLotteriesByOffset`（内部review-items用）と異なり、
 * rejected済みも含めた全件を対象にする（管理者は却下済みも見て再承認できる必要があるため）。
 * 論理削除済み（`lifecycleStatus !== 'active'`）は対象外にする。
 *
 * ページネーション必須（Phase 7の初期実装ではlimit=100固定・offset未使用だったため、
 * 100件を超えるデータでは「要確認」等のタブから古い抽選が一切見えなくなる不具合があった）。
 *
 * `sourcePostPublishedAt`は、この抽選を最初に作成した投稿（`lotteries.sourcePostId`）が
 * 実際にXに投稿された日時（管理者が実際のX投稿と突き合わせて確認できるようにするため、Phase 8）。
 * 統合で複数の投稿が寄与している場合も、あくまで最初の投稿の日時を返す。
 */
export async function listLotteriesForAdmin(db: DbOrTx, opts: ListLotteriesForAdminOptions = {}): Promise<ListLotteriesForAdminResult> {
  const {
    verificationStatus,
    excludeVerificationStatuses,
    search,
    sourcePostPublishedAtFrom,
    sourcePostPublishedAtTo,
    limit = 20,
    offset = 0,
  } = opts;

  const conditions = [eq(lotteries.lifecycleStatus, "active")];
  if (excludeVerificationStatuses && excludeVerificationStatuses.length > 0) {
    // SQLのNOT INは対象列がNULLの行を（三値論理により）除外してしまうため、
    // 「未設定（NULL）」も要確認扱いに含められるようISNULLを明示的にORする。
    conditions.push(or(isNull(lotteries.verificationStatus), notInArray(lotteries.verificationStatus, excludeVerificationStatuses))!);
  } else if (verificationStatus) {
    conditions.push(eq(lotteries.verificationStatus, verificationStatus));
  }
  if (search && search.trim().length > 0) {
    const pattern = `%${search.trim()}%`;
    conditions.push(
      or(
        like(lotteries.productNameRaw, pattern),
        like(lotteries.storeNameRaw, pattern),
        like(lotteries.normalizedProductName, pattern),
        like(lotteries.normalizedStoreName, pattern)
      )!
    );
  }
  if (sourcePostPublishedAtFrom) conditions.push(gte(sourcePosts.publishedAt, sourcePostPublishedAtFrom));
  if (sourcePostPublishedAtTo) conditions.push(lte(sourcePosts.publishedAt, sourcePostPublishedAtTo));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ ...getTableColumns(lotteries), sourcePostPublishedAt: sourcePosts.publishedAt })
      .from(lotteries)
      .leftJoin(sourcePosts, eq(sourcePosts.id, lotteries.sourcePostId))
      .where(where)
      .orderBy(desc(lotteries.createdAt))
      .limit(Math.min(limit, 100))
      .offset(offset),
    db
      .select({ total: count() })
      .from(lotteries)
      .leftJoin(sourcePosts, eq(sourcePosts.id, lotteries.sourcePostId))
      .where(where),
  ]);

  return { lotteries: rows, total };
}

/** 管理画面からの承認。`approvedBy`には管理者のメールアドレスを記録する（監査用）。 */
export async function approveLotteryByAdmin(db: DbOrTx, id: number, approvedBy: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(lotteries)
    .set({ verificationStatus: "approved", approvedBy, approvedAt: now, updatedAt: now })
    .where(eq(lotteries.id, id));
}

/** 管理画面からの却下。`rejectedReason`は任意（未指定ならnull）。 */
export async function rejectLotteryByAdmin(db: DbOrTx, id: number, reason: string | null): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(lotteries)
    .set({ verificationStatus: "rejected", rejectedReason: reason, rejectedAt: now, updatedAt: now })
    .where(eq(lotteries.id, id));
}

export interface AdminLotteryUpdateInput {
  productNameRaw?: string | null;
  storeNameRaw?: string | null;
  applicationEndAt?: string | null;
  resultAnnouncementAt?: string | null;
  purchaseDeadlineAt?: string | null;
  applicationMethod?: string | null;
  applicationUrl?: string | null;
  /** 応募ページURLの複数指定（Phase 9）。指定時は1件目をapplicationUrl/resolvedApplicationUrlにも同期する。 */
  applicationUrls?: string[] | null;
  imageUrl?: string | null;
}

/**
 * 管理画面からのフィールド編集（Phase 7）。`undefined`のキーは更新しない（部分更新）、
 * `null`は明示的なクリアとして扱う。`applicationEndAt`/`resultAnnouncementAt`を管理者が
 * 設定した場合、AI抽出由来の日付のみ値（`_date`）は表示上使われなくなるが、監査のため
 * 残しておいても実害が無い一方、混乱を避けるため明示的にクリアする。
 */
export async function updateLotteryByAdmin(db: DbOrTx, id: number, input: AdminLotteryUpdateInput): Promise<void> {
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };

  if (input.productNameRaw !== undefined) patch.productNameRaw = input.productNameRaw;
  if (input.storeNameRaw !== undefined) patch.storeNameRaw = input.storeNameRaw;
  if (input.applicationMethod !== undefined) patch.applicationMethod = input.applicationMethod;
  if (input.purchaseDeadlineAt !== undefined) patch.purchaseDeadlineAt = input.purchaseDeadlineAt;
  if (input.imageUrl !== undefined) patch.imageUrl = input.imageUrl;

  if (input.applicationEndAt !== undefined) {
    patch.applicationEndAt = input.applicationEndAt;
    if (input.applicationEndAt !== null) {
      patch.applicationEndDate = null;
      patch.applicationEndPrecision = "exact";
    }
  }
  if (input.resultAnnouncementAt !== undefined) {
    patch.resultAnnouncementAt = input.resultAnnouncementAt;
    if (input.resultAnnouncementAt !== null) {
      patch.resultAnnouncementDate = null;
      patch.resultAnnouncementPrecision = "exact";
    }
  }
  if (input.applicationUrl !== undefined) {
    // resolvedApplicationUrlが優先表示されるため（`resolvedApplicationUrl ?? applicationUrl`）、
    // 管理者の修正が確実に反映されるよう両方へ書き込む。自動解決の追跡情報は無効化する。
    patch.applicationUrl = input.applicationUrl;
    patch.resolvedApplicationUrl = input.applicationUrl;
    patch.applicationUrlHttpStatus = null;
    patch.urlResolvedAt = null;
  }
  if (input.applicationUrls !== undefined) {
    // 1件目を既存の単一URL項目（applicationUrl/resolvedApplicationUrl）にも同期し、
    // URL解決ジョブ・同一抽選マッチングのドメイン比較・モバイル側フォールバック表示が
    // 従来通り動作するようにする。
    const urls = (input.applicationUrls ?? []).map((u) => u.trim()).filter((u) => u.length > 0);
    patch.applicationUrls = serializeApplicationUrls(urls.length > 0 ? urls : null);
    patch.applicationUrl = urls[0] ?? null;
    patch.resolvedApplicationUrl = urls[0] ?? null;
    patch.applicationUrlHttpStatus = null;
    patch.urlResolvedAt = null;
  }

  await db.update(lotteries).set(patch).where(eq(lotteries.id, id));
}

export interface AdminLotteryCreateInput {
  productNameRaw: string;
  storeNameRaw: string;
  applicationEndAt?: string | null;
  resultAnnouncementAt?: string | null;
  purchaseDeadlineAt?: string | null;
  applicationMethod?: string | null;
  applicationUrl?: string | null;
}

/**
 * 管理画面からの手動追加（Phase 9）。スクレイピング由来ではないため`sourcePostId`は無し。
 * `normalizedProductName`/`normalizedStoreName`は自動抽出と同じnormalize関数で計算し、
 * 以降の自動再解析でもこの抽選が重複統合・空欄補完の対象になるようにする。
 * 管理者が直接入力した内容のため、`verificationStatus`は自動抽出と同じ既定（extracted）にする
 * （承認は既存の「承認する」ボタンで別途行う一貫した運用にするため、作成時に自動承認はしない）。
 */
export async function createLotteryByAdmin(db: DbOrTx, input: AdminLotteryCreateInput): Promise<number> {
  const now = new Date().toISOString();
  const [row] = await db
    .insert(lotteries)
    .values({
      sourcePostId: null,
      productNameRaw: input.productNameRaw,
      normalizedProductName: normalizeProductName(input.productNameRaw),
      storeNameRaw: input.storeNameRaw,
      normalizedStoreName: normalizeStoreName(input.storeNameRaw),
      normalizerVersion: NORMALIZER_VERSION,
      applicationEndAt: input.applicationEndAt ?? null,
      applicationEndPrecision: input.applicationEndAt ? "exact" : "unknown",
      resultAnnouncementAt: input.resultAnnouncementAt ?? null,
      resultAnnouncementPrecision: input.resultAnnouncementAt ? "exact" : "unknown",
      purchaseDeadlineAt: input.purchaseDeadlineAt ?? null,
      applicationMethod: input.applicationMethod ?? null,
      applicationUrl: input.applicationUrl ?? null,
      applicationUrls: serializeApplicationUrls(input.applicationUrl ? [input.applicationUrl] : null),
      resolvedApplicationUrl: input.applicationUrl ?? null,
      status: "open",
      verificationStatus: "extracted",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: lotteries.id });
  return row.id;
}

export type MergeLotteryError = "duplicate_not_found" | "target_not_found" | "same_lottery" | "target_already_merged";

export interface MergeLotteryResult {
  ok: true;
  targetId: number;
  changedFields: string[];
}

/**
 * 管理画面から「重複として統合」（Phase 8）。duplicateId の内容を targetId へ空欄補完し
 * （`mergeLotteryData`を自動マージと同じロジックで再利用）、`lottery_sources`/
 * `lottery_field_history`をtarget側へ付け替え、duplicate側は`lifecycleStatus: "merged"`,
 * `mergedIntoLotteryId: targetId`にする（物理削除しない）。
 * 公開一覧（`listLotteries`）・管理一覧（`listLotteriesForAdmin`）はどちらも
 * `lifecycleStatus = "active"`のみを対象にしているため、統合後は自動的に非表示になる。
 */
export async function mergeLotteryIntoTarget(
  db: Db,
  duplicateId: number,
  targetId: number
): Promise<MergeLotteryResult | MergeLotteryError> {
  if (duplicateId === targetId) return "same_lottery";

  return db.transaction(async (tx) => {
    const [duplicateRows, targetRows] = await Promise.all([
      tx.select().from(lotteries).where(eq(lotteries.id, duplicateId)),
      tx.select().from(lotteries).where(eq(lotteries.id, targetId)),
    ]);
    const duplicate = duplicateRows[0];
    const target = targetRows[0];
    if (!duplicate) return "duplicate_not_found";
    if (!target) return "target_not_found";
    if (target.lifecycleStatus === "merged") return "target_already_merged";

    const now = new Date().toISOString();
    const merged = mergeLotteryData(
      target as unknown as Record<string, string | null>,
      duplicate as unknown as Record<string, string | null>
    );

    if (Object.keys(merged.updates).length > 0 || merged.verificationStatus !== target.verificationStatus) {
      await tx
        .update(lotteries)
        .set({ ...merged.updates, verificationStatus: merged.verificationStatus, updatedAt: now })
        .where(eq(lotteries.id, targetId));
    }
    for (const c of merged.changes) {
      await tx.insert(lotteryFieldHistory).values({
        lotteryId: targetId,
        sourcePostId: null,
        fieldName: c.fieldName,
        oldValue: c.oldValue,
        newValue: c.newValue,
        changeType: c.changeType,
      });
    }

    // 重複側の情報源・変更履歴をtargetへ付け替える（provenanceを保持する）。
    await tx.update(lotterySources).set({ lotteryId: targetId }).where(eq(lotterySources.lotteryId, duplicateId));
    await tx.update(lotteryFieldHistory).set({ lotteryId: targetId }).where(eq(lotteryFieldHistory.lotteryId, duplicateId));

    await tx
      .update(lotteries)
      .set({ lifecycleStatus: "merged", mergedIntoLotteryId: targetId, updatedAt: now })
      .where(eq(lotteries.id, duplicateId));

    return { ok: true, targetId, changedFields: merged.changes.map((c) => c.fieldName) };
  });
}
