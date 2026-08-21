/**
 * 過去の再解析で"own"マッチが成立せず、修正済みの抽出結果が lottery_update_candidates に
 * status='pending' のまま溜まり、管理画面が参照する active な lotteries には一切反映されて
 * いなかった投稿を、直接解決する一回限りのスクリプト。
 *
 * 背景: syncLotteriesFromAnalysis の"own"マッチは、同一sourcePostIdの既存active行と
 * 「商品名＋店舗名」の正規化キーが完全一致する場合のみ、その場でactive行を直接更新する。
 * 抽出ロジックの変更（parserVersionの更新）でキー自体が変わると"own"マッチが成立せず、
 * 全く別の既存抽選への曖昧一致としてcandidateへ振り分けられるだけになり、正しい抽出結果が
 * 管理画面に反映されないまま溜まり続けていた（2026-08、sourcePostId=253等で確認）。
 *
 * 対象: status='pending' の lottery_update_candidates を1件以上持つ sourcePostId。
 * 各対象ごとに:
 *  1. raw_html を再パースし analyzePost() で最新の抽出結果を得る（reanalyzeAllPosts.ts と同じ経路）。
 *  2. そのsourcePostIdが直接作成した既存 active lotteries（"own"）のうち、
 *     verificationStatus が approved/rejected でなく、保護リスト（user_lotteries・checklist_progress
 *     から参照されているlottery_id）にも含まれないものを lifecycleStatus='orphaned' に変更する
 *     （新しい抽出結果に置き換えられるため）。
 *  3. 最新の抽出結果を新規 active レコードとして直接挿入する。同一sourcePostからの再抽出である
 *     ことが確定しているため、他投稿とのあいまい一致（matchExistingLottery）を経由する必要が無い。
 *  4. そのsourcePostIdに残っていたpending候補（他投稿への誤マッチ含む）は全て status='ignored' にする
 *     （新しいactive行に置き換わったため、レビューキューにノイズを残さない）。
 *
 * 承認/却下済み・ユーザー参照ありのlotteryは一切変更しない（スキップしログに残す）。
 *
 * 環境変数:
 *   TURSO_DATABASE_URL / TURSO_AUTH_TOKEN … 対象DB
 *   DRY_RUN=1 … 実際には書き込まず、実行内容だけ表示する
 *
 * 実行: npx tsx scripts/reconcileStalePendingCandidates.ts
 */
import { eq, inArray, and } from "drizzle-orm";
import { createDb } from "../src/db/client.node.ts";
import {
  sourcePosts,
  lotteries,
  lotteryUpdateCandidates,
  lotteryFieldHistory,
  lotterySources,
  userLotteries,
  checklistProgress,
} from "../src/db/schema.ts";
import { toLotteryRow } from "../src/repositories/lotteryRepository.ts";
import { analyzePost } from "../../scraper/src/lottery/analyzePost.ts";
import { parseTweetArticle } from "../../scraper/src/scraping/x/parseTweetDom.ts";
import type { RawPost } from "../../scraper/src/scraping/x/parseTweetDom.ts";

const DRY_RUN = process.env.DRY_RUN === "1";

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildRawPostFromColumns(sp: typeof sourcePosts.$inferSelect): RawPost {
  return {
    tweetId: sp.externalPostId,
    authorId: null,
    authorUsername: null,
    authorDisplayName: null,
    bodyText: sp.bodyRaw ?? "",
    publishedAt: sp.publishedAt,
    sourceUrl: sp.sourceUrl ?? "https://x.com",
    externalUrls: parseJsonArray(sp.externalUrls),
    externalLinks: [],
    imageUrls: parseJsonArray(sp.imageUrls),
    rawHtml: "",
    cleanedHtml: "",
  };
}

async function main(): Promise<void> {
  const db = createDb({
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
  });

  const [userLotteryRows, checklistRows] = await Promise.all([
    db.select({ lotteryId: userLotteries.lotteryId }).from(userLotteries),
    db.select({ lotteryId: checklistProgress.lotteryId }).from(checklistProgress),
  ]);
  const protectedLotteryIds = new Set<number>([
    ...userLotteryRows.map((r) => r.lotteryId),
    ...checklistRows.map((r) => r.lotteryId),
  ]);
  console.log(`[reconcile] 保護対象lottery_id: ${[...protectedLotteryIds].join(", ") || "(なし)"}`);

  const pendingRows = await db
    .select({ sourcePostId: lotteryUpdateCandidates.sourcePostId })
    .from(lotteryUpdateCandidates)
    .where(eq(lotteryUpdateCandidates.status, "pending"));
  const targetSourcePostIds = [...new Set(pendingRows.map((r) => r.sourcePostId))].sort((a, b) => a - b);
  console.log(`[reconcile] 対象sourcePostId: ${targetSourcePostIds.length}件 / DRY_RUN=${DRY_RUN}`);

  let orphaned = 0;
  let inserted = 0;
  let ignoredCandidates = 0;
  let skippedProtected = 0;
  let failed = 0;

  for (const sourcePostId of targetSourcePostIds) {
    try {
      const [sp] = await db.select().from(sourcePosts).where(eq(sourcePosts.id, sourcePostId));
      if (!sp) {
        console.warn(`[reconcile] sourcePostId=${sourcePostId} が見つからずスキップ`);
        continue;
      }
      const parsed = sp.rawHtml ? parseTweetArticle(sp.rawHtml) : null;
      const rawPost: RawPost = parsed ?? buildRawPostFromColumns(sp);
      const analysis = await analyzePost(rawPost);
      const freshLotteries = analysis.extractedLotteries.filter((l) => l.productNameRaw && l.storeNameRaw);

      const ownActive = await db
        .select()
        .from(lotteries)
        .where(and(eq(lotteries.sourcePostId, sourcePostId), eq(lotteries.lifecycleStatus, "active")));

      const toOrphan = ownActive.filter(
        (row) => row.verificationStatus !== "approved" && row.verificationStatus !== "rejected" && !protectedLotteryIds.has(row.id)
      );
      const kept = ownActive.filter(
        (row) => row.verificationStatus === "approved" || row.verificationStatus === "rejected" || protectedLotteryIds.has(row.id)
      );
      if (kept.length > 0) {
        skippedProtected += kept.length;
        console.log(
          `[reconcile] sourcePostId=${sourcePostId}: 保護され変更しないactive行 ${kept.length}件 (id=${kept.map((k) => k.id).join(",")})`
        );
      }

      console.log(
        `[reconcile] sourcePostId=${sourcePostId}: own active ${ownActive.length}件中 orphaned化対象 ${toOrphan.length}件 / 新規挿入 ${freshLotteries.length}件`
      );

      if (DRY_RUN) continue;

      if (toOrphan.length > 0) {
        await db
          .update(lotteries)
          .set({ lifecycleStatus: "orphaned", orphanedAt: new Date().toISOString() })
          .where(
            inArray(
              lotteries.id,
              toOrphan.map((r) => r.id)
            )
          );
        orphaned += toOrphan.length;
      }

      if (freshLotteries.length > 0) {
        const rows = freshLotteries.map((l) => toLotteryRow(sourcePostId, l));
        const insertedRows = await db.insert(lotteries).values(rows).returning({ id: lotteries.id });
        inserted += insertedRows.length;

        const historyRows: {
          lotteryId: number;
          sourcePostId: number;
          fieldName: string;
          oldValue: null;
          newValue: string;
          changeType: "created";
        }[] = [];
        const sourceRows: {
          lotteryId: number;
          sourcePostId: number;
          matchAction: "new";
          matchScore: string;
          matchReason: string;
          contributedFields: string;
        }[] = [];
        for (let i = 0; i < rows.length; i++) {
          const lotteryId = insertedRows[i].id;
          const row = rows[i];
          const contributedFields = Object.entries(row)
            .filter(([, v]) => v !== null && v !== undefined && String(v).length > 0)
            .map(([k]) => k);
          for (const f of contributedFields) {
            historyRows.push({
              lotteryId,
              sourcePostId,
              fieldName: f,
              oldValue: null,
              newValue: String((row as Record<string, unknown>)[f]),
              changeType: "created",
            });
          }
          sourceRows.push({
            lotteryId,
            sourcePostId,
            matchAction: "new",
            matchScore: "0",
            matchReason: "reconcile_stale_pending",
            contributedFields: JSON.stringify(contributedFields),
          });
        }
        if (historyRows.length > 0) await db.insert(lotteryFieldHistory).values(historyRows);
        if (sourceRows.length > 0) await db.insert(lotterySources).values(sourceRows);
      }

      const updateResult = await db
        .update(lotteryUpdateCandidates)
        .set({ status: "ignored", resolvedBy: "system_reconcile", resolvedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(and(eq(lotteryUpdateCandidates.sourcePostId, sourcePostId), eq(lotteryUpdateCandidates.status, "pending")))
        .returning({ id: lotteryUpdateCandidates.id });
      ignoredCandidates += updateResult.length;
    } catch (e) {
      failed++;
      console.error(`[reconcile] sourcePostId=${sourcePostId} 失敗:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(
    `[reconcile] 完了 対象=${targetSourcePostIds.length} orphaned=${orphaned} inserted=${inserted} ignoredCandidates=${ignoredCandidates} skippedProtectedRows=${skippedProtected} failed=${failed}`
  );
}

main().catch((e) => {
  console.error("[reconcile][fatal]", e);
  process.exit(1);
});
