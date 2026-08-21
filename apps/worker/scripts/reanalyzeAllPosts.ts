/**
 * 過去のsource_postsを全件（または期間指定）再解析するための一回限りのスクリプト（Phase 8）。
 * PARSER_VERSIONを上げた際、既存投稿にも新しい分類/抽出ロジックを反映させるために使う。
 *
 * 通常の/ingestと全く同じ経路（persistAnalysis → 同一抽選マッチング）を通すため、
 * 重複統合・空欄補完も普段の運用と同様に働く。source_posts自体は読み取り専用で使う。
 *
 * RawPostの復元は、保存済みの raw_html を parseTweetArticle() で再パースして行う
 * （DBカラムから個別に組み立てると externalLinks の表示テキスト（展開後ドメイン）が
 * 失われ、URL分類・applicationUrl判定が正しく動かないため。2026-08、実データで確認。
 * raw_html が空/パース失敗の場合のみDBカラムからの手組み立てにフォールバックする）。
 *
 * 環境変数:
 *   TURSO_DATABASE_URL / TURSO_AUTH_TOKEN … 対象DB
 *   DRY_RUN=1 … 実際にはpersistAnalysisを呼ばず、変化する見込みだけ表示する
 *   PUBLISHED_AFTER … 例 2026-08-01（この日時以降のpublished_atのみ対象。省略時は全件）
 *   PUBLISHED_BEFORE … 例 2026-08-21（この日時より前のpublished_atのみ対象。省略時は全件）
 *
 * 実行: npx tsx scripts/reanalyzeAllPosts.ts （もしくは node --experimental-strip-types）
 */
import { and, eq, gte, lt } from "drizzle-orm";
import { createDb } from "../src/db/client.node.ts";
import { sourcePosts, postAnalyses, lotteries } from "../src/db/schema.ts";
import { persistAnalysis, decideAnalysisAction } from "../src/repositories/analysisRepository.ts";
import { analyzePost } from "../../scraper/src/lottery/analyzePost.ts";
import { parseTweetArticle } from "../../scraper/src/scraping/x/parseTweetDom.ts";
import type { RawPost } from "../../scraper/src/scraping/x/parseTweetDom.ts";

const DRY_RUN = process.env.DRY_RUN === "1";
const PUBLISHED_AFTER = process.env.PUBLISHED_AFTER || null;
const PUBLISHED_BEFORE = process.env.PUBLISHED_BEFORE || null;

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** DBカラムから手組み立てするフォールバック（raw_htmlが無い/パース失敗の場合のみ）。externalLinksは復元できない。 */
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

  const before = await db.select().from(lotteries);
  const conditions = [
    ...(PUBLISHED_AFTER ? [gte(sourcePosts.publishedAt, PUBLISHED_AFTER)] : []),
    ...(PUBLISHED_BEFORE ? [lt(sourcePosts.publishedAt, PUBLISHED_BEFORE)] : []),
  ];
  const posts = conditions.length > 0 ? await db.select().from(sourcePosts).where(and(...conditions)) : await db.select().from(sourcePosts);
  console.log(
    `[reanalyze] 対象: source_posts ${posts.length}件（PUBLISHED_AFTER=${PUBLISHED_AFTER ?? "-"} PUBLISHED_BEFORE=${PUBLISHED_BEFORE ?? "-"}） / 実行前 lotteries ${before.length}件 / DRY_RUN=${DRY_RUN}`
  );

  let reused = 0;
  let reinserted = 0;
  let failed = 0;
  let rawHtmlFallback = 0;

  for (const sp of posts) {
    const parsed = sp.rawHtml ? parseTweetArticle(sp.rawHtml) : null;
    if (!parsed) rawHtmlFallback++;
    const rawPost: RawPost = parsed ?? buildRawPostFromColumns(sp);

    try {
      const analysis = await analyzePost(rawPost);

      if (DRY_RUN) {
        const priors = await db.select().from(postAnalyses).where(eq(postAnalyses.sourcePostId, sp.id));
        const action = decideAnalysisAction(priors, analysis);
        if (action === "reused") reused++;
        else {
          reinserted++;
          console.log(
            `[dry-run] sourcePostId=${sp.id} isLottery=${analysis.isLotteryInformation} status=${analysis.analysisStatus} count=${analysis.extractedLotteries.length}`
          );
        }
        continue;
      }

      const result = await persistAnalysis(db, sp.id, analysis);
      if (result.action === "reused") reused++;
      else reinserted++;
    } catch (e) {
      failed++;
      console.error(`[reanalyze] sourcePostId=${sp.id} 失敗:`, e instanceof Error ? e.message : e);
    }
  }

  const after = DRY_RUN ? before : await db.select().from(lotteries);
  console.log(
    `[reanalyze] 完了 reused=${reused} reinserted=${reinserted} failed=${failed} rawHtmlFallback=${rawHtmlFallback} | lotteries: ${before.length} → ${after.length}`
  );
}

main().catch((e) => {
  console.error("[reanalyze][fatal]", e);
  process.exit(1);
});
