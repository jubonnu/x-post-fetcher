/**
 * lottery_update_candidates（Phase 11）の9シナリオ検証スクリプト。
 * ローカル（file:local.db）でもstaging/production Turso（TURSO_DATABASE_URL/TURSO_AUTH_TOKEN経由）
 * でも実行できる。実DBに直接接続し、`/ingest`と同じ`persistAnalysis`を呼ぶため、
 * INGEST_TOKENが無くても本番運用時と全く同じマッチ/候補化ロジックを検証できる。
 *
 * cleanupの安全設計（重要）: このスクリプトが過去、`source_post_id`の数値範囲で`lotteries`を
 * 再スキャンして削除対象を決めていたところ、staging DBの既存モックデータ
 * （`source_posts`が0件のため`lotteries.source_post_id`が実体の無い古いID値を指したまま
 * 残っていた）とID範囲が偶然衝突し、既存の1件を誤削除する事故が発生した。
 * この教訓から、削除対象は`persistAnalysis`の戻り値から`scripts/lib/scenarioCleanup.ts`の
 * トラッカーで直接収集したIDのみとし、外部キーでの再スキャン・数値範囲での絞り込みを
 * 一切行わない。`assertOnlyTracked`が実行時ガードとして機能し、この方針から逸脱した削除は
 * 例外で拒否される。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/verifyLotteryUpdateCandidateScenarios.ts
 *   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node --experimental-strip-types scripts/verifyLotteryUpdateCandidateScenarios.ts
 */
import { eq, inArray } from "drizzle-orm";
import { createDb } from "../src/db/client.node.ts";
import { lotteries, lotteryFieldHistory, lotterySources, lotteryUpdateCandidates, postAnalyses, sourcePosts } from "../src/db/schema.ts";
import { persistAnalysis } from "../src/repositories/analysisRepository.ts";
import {
  assertOnlyTracked,
  createScenarioTracker,
  trackLotteryResults,
  trackSourcePost,
  trackedIdsAsDeletionTargets,
} from "./lib/scenarioCleanup.ts";
import type { AnalysisInput, ExtractedLottery } from "@x-post/shared";

const db = createDb({
  TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
  TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
});

const RUN_TAG = `stg-verify-${Date.now()}`;
const tracker = createScenarioTracker();

function makeLottery(overrides: Partial<ExtractedLottery> = {}): ExtractedLottery {
  return {
    productNameRaw: "テスト商品",
    storeNameRaw: "テスト店",
    cardType: "pokemon",
    storeBranchRaw: null,
    region: null,
    applicationUrl: null,
    officialInformationUrl: null,
    appDownloadUrl: null,
    applicationMethod: null,
    eligibilityConditions: null,
    pickupMethod: null,
    paymentMethod: null,
    price: null,
    notes: null,
    confirmedOpenAt: null,
    applicationStart: { at: null, date: null, precision: "unknown", status: "ok" },
    applicationEnd: { at: null, date: "2026-08-20", precision: "date_only", status: "ok" },
    resultAnnouncementStart: { at: null, date: null, precision: "unknown", status: "ok" },
    resultAnnouncement: { at: null, date: null, precision: "unknown", status: "ok" },
    purchaseStart: { at: null, date: null, precision: "unknown", status: "ok" },
    purchaseDeadline: { at: null, date: null, precision: "unknown", status: "ok" },
    ...overrides,
  };
}

async function insertSourcePost(suffix: string): Promise<number> {
  const externalPostId = `${RUN_TAG}-${suffix}`;
  const [row] = await db
    .insert(sourcePosts)
    .values({
      platform: "x",
      externalPostId,
      sourceUrl: `https://x.com/test/${externalPostId}`,
      bodyRaw: `staging verification: ${suffix}`,
      contentHash: `hash-${externalPostId}`,
      fetchedAt: new Date().toISOString(),
    })
    .returning({ id: sourcePosts.id });
  trackSourcePost(tracker, row.id);
  return row.id;
}

function analysisFor(lots: ExtractedLottery[], parserVersion = "stg-verify-1"): AnalysisInput {
  return {
    postType: "lottery_started",
    isLotteryInformation: true,
    cardType: "pokemon",
    confidenceScore: 0.9,
    analysisStatus: "success",
    parserVersion,
    inputContentHash: `ignored-${Math.random()}`,
    extractedLotteries: lots,
    urls: [],
    errorMessage: null,
  };
}

/** persistAnalysisを呼び、戻り値のlotteryId/candidateIdを必ずトラッカーへ記録してから返す。 */
async function runAnalysis(sourcePostId: number, analysis: AnalysisInput) {
  const result = await persistAnalysis(db, sourcePostId, analysis);
  trackLotteryResults(tracker, result.lotteryResults);
  return result;
}

function mustGet<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`[verify] expected ${label} to be set but got ${String(value)}`);
  return value;
}

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  OK   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}`, detail ?? "");
  }
}

async function main() {
  console.log(`=== Verification run ${RUN_TAG} ===`);

  {
    console.log("\n(a) new post -> new lottery (no strong existing candidate)");
    const sp = await insertSourcePost("a");
    const r = await runAnalysis(sp, analysisFor([makeLottery({ productNameRaw: `${RUN_TAG}-商品A` })]));
    assert("action=inserted", r.action === "inserted", r);
    assert("matchAction=new", r.lotteryResults?.[0]?.matchAction === "new", r.lotteryResults);
  }

  {
    console.log("\n(b) later post (purchase deadline only) -> update candidate");
    const spOriginal = await insertSourcePost("b-original");
    const rOriginal = await runAnalysis(spOriginal, analysisFor([makeLottery({ productNameRaw: `${RUN_TAG}-商品B` })]));
    const targetLotteryIdB = rOriginal.lotteryResults?.[0]?.lotteryId ?? null;

    const spFollowup = await insertSourcePost("b-followup");
    const rFollowup = await runAnalysis(
      spFollowup,
      analysisFor([
        makeLottery({
          productNameRaw: `${RUN_TAG}-商品B`,
          purchaseDeadline: { at: null, date: "2026-08-27", precision: "date_only", status: "ok" },
        }),
      ])
    );
    const result = rFollowup.lotteryResults?.[0];
    assert("matchAction=candidate", result?.matchAction === "candidate", result);

    const [target] = await db.select().from(lotteries).where(eq(lotteries.id, targetLotteryIdB!));
    assert("existing lottery NOT auto-updated (purchaseDeadlineAt still null)", target.purchaseDeadlineAt === null, target.purchaseDeadlineAt);
  }

  {
    console.log("\n(c) later post (result announcement only) -> update candidate");
    const spOriginal = await insertSourcePost("c-original");
    await runAnalysis(spOriginal, analysisFor([makeLottery({ productNameRaw: `${RUN_TAG}-商品C` })]));

    const spFollowup = await insertSourcePost("c-followup");
    const rFollowup = await runAnalysis(
      spFollowup,
      analysisFor([
        makeLottery({
          productNameRaw: `${RUN_TAG}-商品C`,
          applicationEnd: { at: null, date: null, precision: "unknown", status: "ok" },
          resultAnnouncement: { at: null, date: "2026-08-25", precision: "date_only", status: "ok" },
        }),
      ])
    );
    assert("matchAction=candidate", rFollowup.lotteryResults?.[0]?.matchAction === "candidate", rFollowup.lotteryResults);
  }

  {
    console.log("\n(d) similar product, different store & deadline -> new (not candidate)");
    const spOriginal = await insertSourcePost("d-original");
    await runAnalysis(
      spOriginal,
      analysisFor([
        makeLottery({
          productNameRaw: `${RUN_TAG}-商品D`,
          storeNameRaw: "店舗X",
          applicationEnd: { at: null, date: "2026-08-20", precision: "date_only", status: "ok" },
        }),
      ])
    );
    const spOther = await insertSourcePost("d-other");
    const rOther = await runAnalysis(
      spOther,
      analysisFor([
        makeLottery({
          productNameRaw: `${RUN_TAG}-商品D`,
          storeNameRaw: "全く別の店舗Y",
          applicationEnd: { at: null, date: "2026-11-30", precision: "date_only", status: "ok" },
        }),
      ])
    );
    assert("matchAction=new", rOther.lotteryResults?.[0]?.matchAction === "new", rOther.lotteryResults);
  }

  {
    console.log("\n(e) 1 post with 2 lotteries -> exactly 2 candidate rows");
    const spExistingA = await insertSourcePost("e-existing-a");
    await runAnalysis(spExistingA, analysisFor([makeLottery({ productNameRaw: `${RUN_TAG}-商品EA`, storeNameRaw: "店舗EA" })]));
    const spExistingB = await insertSourcePost("e-existing-b");
    await runAnalysis(spExistingB, analysisFor([makeLottery({ productNameRaw: `${RUN_TAG}-商品EB`, storeNameRaw: "店舗EB" })]));

    const spSummary = await insertSourcePost("e-summary");
    const rSummary = await runAnalysis(
      spSummary,
      analysisFor([
        makeLottery({ productNameRaw: `${RUN_TAG}-商品EA`, storeNameRaw: "店舗EA" }),
        makeLottery({ productNameRaw: `${RUN_TAG}-商品EB`, storeNameRaw: "店舗EB" }),
      ])
    );
    assert("lotteryCount=2", rSummary.lotteryCount === 2, rSummary);
    assert("both matchAction=candidate", rSummary.lotteryResults?.every((r) => r.matchAction === "candidate") ?? false, rSummary.lotteryResults);
    const ids = new Set(rSummary.lotteryResults?.map((r) => r.candidateId));
    assert("2 distinct candidateIds", ids.size === 2, ids);

    const rows = await db.select().from(lotteryUpdateCandidates).where(eq(lotteryUpdateCandidates.sourcePostId, spSummary));
    assert("exactly 2 DB rows for this sourcePostId", rows.length === 2, rows.length);
  }

  {
    console.log("\n(f) same sourcePostId reprocessed -> no duplicate candidates");
    const spOriginal = await insertSourcePost("f-original");
    await runAnalysis(spOriginal, analysisFor([makeLottery({ productNameRaw: `${RUN_TAG}-商品F` })]));

    const spFollowup = await insertSourcePost("f-followup");
    const analysis = analysisFor([makeLottery({ productNameRaw: `${RUN_TAG}-商品F`, applicationMethod: "リプライ" })], "stg-verify-1");
    const r1 = await runAnalysis(spFollowup, analysis);
    const analysis2 = { ...analysis, parserVersion: "stg-verify-2" };
    const r2 = await runAnalysis(spFollowup, analysis2);

    assert("candidateId stays the same across reanalysis", r1.lotteryResults?.[0]?.candidateId === r2.lotteryResults?.[0]?.candidateId, {
      r1: r1.lotteryResults,
      r2: r2.lotteryResults,
    });
    const rows = await db.select().from(lotteryUpdateCandidates).where(eq(lotteryUpdateCandidates.sourcePostId, spFollowup));
    assert("exactly 1 DB row", rows.length === 1, rows.length);
  }

  {
    console.log("\n(g) parserVersion reanalysis -> approved lottery stays completely unchanged");
    const spOriginal = await insertSourcePost("g-original");
    const rOriginal = await runAnalysis(spOriginal, analysisFor([makeLottery({ productNameRaw: `${RUN_TAG}-商品G` })]));
    const targetId = mustGet(rOriginal.lotteryResults?.[0]?.lotteryId, "g scenario target lotteryId");
    await db.update(lotteries).set({ verificationStatus: "approved", approvedBy: "stg-verify" }).where(eq(lotteries.id, targetId));

    const spFollowup = await insertSourcePost("g-followup");
    const analysis = analysisFor([makeLottery({ productNameRaw: `${RUN_TAG}-商品G`, applicationMethod: "DM" })]);
    await runAnalysis(spFollowup, analysis);
    await runAnalysis(spFollowup, { ...analysis, parserVersion: "stg-verify-2" });

    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, targetId));
    assert("verificationStatus still approved", row.verificationStatus === "approved", row.verificationStatus);
    assert("applicationMethod still null (not overwritten)", row.applicationMethod === null, row.applicationMethod);
  }

  {
    console.log("\n(h) ignored candidate is not resurrected by reanalysis");
    const spOriginal = await insertSourcePost("h-original");
    await runAnalysis(spOriginal, analysisFor([makeLottery({ productNameRaw: `${RUN_TAG}-商品H` })]));

    const spFollowup = await insertSourcePost("h-followup");
    const analysis = analysisFor([makeLottery({ productNameRaw: `${RUN_TAG}-商品H` })]);
    const r1 = await runAnalysis(spFollowup, analysis);
    const candidateId = mustGet(r1.lotteryResults?.[0]?.candidateId, "h scenario candidateId");

    const now = new Date().toISOString();
    await db.update(lotteryUpdateCandidates).set({ status: "ignored", resolvedBy: "stg-verify", resolvedAt: now }).where(eq(lotteryUpdateCandidates.id, candidateId));

    await runAnalysis(spFollowup, { ...analysis, parserVersion: "stg-verify-2" });
    const [row] = await db.select().from(lotteryUpdateCandidates).where(eq(lotteryUpdateCandidates.id, candidateId));
    assert("status stays ignored", row.status === "ignored", row.status);
    const allRows = await db.select().from(lotteryUpdateCandidates).where(eq(lotteryUpdateCandidates.sourcePostId, spFollowup));
    assert("no new row created", allRows.length === 1, allRows.length);
  }

  {
    console.log("\n(i) applied candidate is not duplicately regenerated by reanalysis");
    const spOriginal = await insertSourcePost("i-original");
    await runAnalysis(spOriginal, analysisFor([makeLottery({ productNameRaw: `${RUN_TAG}-商品I`, region: null })]));

    const spFollowup = await insertSourcePost("i-followup");
    const analysis = analysisFor([makeLottery({ productNameRaw: `${RUN_TAG}-商品I`, region: "関西" })]);
    const r1 = await runAnalysis(spFollowup, analysis);
    const candidateId = mustGet(r1.lotteryResults?.[0]?.candidateId, "i scenario candidateId");

    const now = new Date().toISOString();
    await db
      .update(lotteryUpdateCandidates)
      .set({ status: "applied", resolvedBy: "stg-verify", resolvedAt: now, appliedFields: JSON.stringify(["region"]) })
      .where(eq(lotteryUpdateCandidates.id, candidateId));

    await runAnalysis(spFollowup, { ...analysis, parserVersion: "stg-verify-2" });
    const allRows = await db.select().from(lotteryUpdateCandidates).where(eq(lotteryUpdateCandidates.sourcePostId, spFollowup));
    assert("no new row created", allRows.length === 1, allRows.length);
    assert("status stays applied", allRows[0].status === "applied", allRows[0].status);
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  await cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

/**
 * このテスト実行で実際に作成したIDだけを削除する（`assertOnlyTracked`を必ず経由する）。
 * source_postsについては、トラッキング済みIDに加えて`external_post_id LIKE '{RUN_TAG}-%'`
 * でも二重に絞り込む（多層防御。IDトラッキングだけに依存しない）。
 */
async function cleanup() {
  console.log("\nCleaning up test data created by this run (tracked IDs only)...");

  const candidateIds = trackedIdsAsDeletionTargets(tracker.candidateIds);
  assertOnlyTracked("candidate", candidateIds, tracker.candidateIds);
  if (candidateIds.length > 0) {
    await db.delete(lotteryUpdateCandidates).where(inArray(lotteryUpdateCandidates.id, candidateIds));
  }
  // sourcePostIdに紐づくcandidatesも、own_updated等でトラッキングされていない可能性があるため
  // 併せて削除する（ただし対象はトラッキング済みsourcePostIdのみに厳密に限定する）。
  const sourcePostIds = trackedIdsAsDeletionTargets(tracker.sourcePostIds);
  assertOnlyTracked("sourcePost", sourcePostIds, tracker.sourcePostIds);
  if (sourcePostIds.length > 0) {
    await db.delete(lotteryUpdateCandidates).where(inArray(lotteryUpdateCandidates.sourcePostId, sourcePostIds));
  }

  const lotteryIds = trackedIdsAsDeletionTargets(tracker.lotteryIds);
  assertOnlyTracked("lottery", lotteryIds, tracker.lotteryIds);
  if (lotteryIds.length > 0) {
    await db.delete(lotteryFieldHistory).where(inArray(lotteryFieldHistory.lotteryId, lotteryIds));
    await db.delete(lotterySources).where(inArray(lotterySources.lotteryId, lotteryIds));
  }
  if (sourcePostIds.length > 0) {
    await db.delete(lotteryFieldHistory).where(inArray(lotteryFieldHistory.sourcePostId, sourcePostIds));
    await db.delete(lotterySources).where(inArray(lotterySources.sourcePostId, sourcePostIds));
    await db.delete(postAnalyses).where(inArray(postAnalyses.sourcePostId, sourcePostIds));
  }
  if (lotteryIds.length > 0) {
    await db.delete(lotteries).where(inArray(lotteries.id, lotteryIds));
  }
  if (sourcePostIds.length > 0) {
    // 二重防御: IDトラッキングに加え、このRUN_TAGのexternal_post_idであることも確認してから削除する。
    const rows = await db.select({ id: sourcePosts.id, externalPostId: sourcePosts.externalPostId }).from(sourcePosts).where(inArray(sourcePosts.id, sourcePostIds));
    const safeToDeleteIds = rows.filter((r) => r.externalPostId.startsWith(`${RUN_TAG}-`)).map((r) => r.id);
    assertOnlyTracked("sourcePost(prefix-checked)", safeToDeleteIds, tracker.sourcePostIds);
    if (safeToDeleteIds.length !== sourcePostIds.length) {
      console.warn(
        `[cleanup] WARNING: ${sourcePostIds.length - safeToDeleteIds.length} tracked source_post id(s) did not match the expected external_post_id prefix and were left untouched.`
      );
    }
    if (safeToDeleteIds.length > 0) {
      await db.delete(sourcePosts).where(inArray(sourcePosts.id, safeToDeleteIds));
    }
  }

  console.log(`Deleted ${sourcePostIds.length} source_posts, ${lotteryIds.length} lotteries, ${candidateIds.length}+ candidates, and their history.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
