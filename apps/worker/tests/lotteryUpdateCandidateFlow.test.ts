/**
 * Phase 11 再設計の end-to-end 回帰テスト（`syncLotteriesFromAnalysis`経由）。
 * ユーザー確定仕様の9シナリオのうち、DBレベルで再現できるものをここで自動化する
 * （実際のX投稿を使った本番同等データでのstaging検証は別途タスクで実施する）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { lotteries, lotteryUpdateCandidates, sourcePosts } from "../src/db/schema.ts";
import { syncLotteriesFromAnalysis, toLotteryRow } from "../src/repositories/lotteryRepository.ts";
import {
  getLotteryUpdateCandidateById,
  ignoreLotteryUpdateCandidate,
  applyLotteryUpdateCandidate,
} from "../src/repositories/lotteryUpdateCandidateRepository.ts";
import type { ExtractedLottery } from "@x-post/shared";

const DB_FILE = resolve(process.cwd(), `.tmp-candidate-flow-${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
});

afterAll(() => {
  rmSync(DB_FILE);
});

function makeLottery(overrides: Partial<ExtractedLottery> = {}): ExtractedLottery {
  return {
    productNameRaw: "テスト商品A",
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

async function insertSourcePost(externalPostId: string): Promise<number> {
  const [row] = await db
    .insert(sourcePosts)
    .values({ platform: "x", externalPostId, contentHash: `hash-${externalPostId}`, fetchedAt: new Date().toISOString() })
    .returning({ id: sourcePosts.id });
  return row.id;
}

describe("(a) 新規投稿 → 新規候補（既存に有力な候補が無い）", () => {
  it("既存抽選が無ければ直接新規lotteryとして挿入される", async () => {
    const sp = await insertSourcePost(`scenario-a-${Date.now()}`);
    const candidate = toLotteryRow(sp, makeLottery({ productNameRaw: `新規商品A-${Date.now()}` }));
    const result = await syncLotteriesFromAnalysis(db, sp, [candidate]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].matchAction).toBe("new");
    expect(result.inserted).toBe(1);
    expect(result.candidates).toBe(0);
  });
});

describe("(b)(c) 同一抽選の後続投稿（購入期限のみ/当選発表のみ） → 更新候補", () => {
  it("商品名・店舗名が一致する後続投稿は既存抽選を自動更新せず、更新候補になる", async () => {
    const sp1 = await insertSourcePost(`scenario-b-original-${Date.now()}`);
    const productName = `本命商品B-${Date.now()}`;
    const original = toLotteryRow(sp1, makeLottery({ productNameRaw: productName }));
    const firstResult = await syncLotteriesFromAnalysis(db, sp1, [original]);
    const targetLotteryId = firstResult.results[0].lotteryId!;

    const sp2 = await insertSourcePost(`scenario-b-followup-${Date.now()}`);
    // 購入期限のみの後続投稿（商品名・店舗名・締切は同一 → 高スコア）
    const followup = toLotteryRow(
      sp2,
      makeLottery({
        productNameRaw: productName,
        purchaseDeadline: { at: null, date: "2026-08-27", precision: "date_only", status: "ok" },
      })
    );
    const secondResult = await syncLotteriesFromAnalysis(db, sp2, [followup]);

    expect(secondResult.results[0].matchAction).toBe("candidate");
    expect(secondResult.candidates).toBe(1);

    const candidateId = secondResult.results[0].candidateId!;
    const candidateRow = await getLotteryUpdateCandidateById(db, candidateId);
    expect(candidateRow?.targetLotteryId).toBe(targetLotteryId);
    expect(candidateRow?.status).toBe("pending");

    // 既存抽選は自動更新されていない
    const [target] = await db.select().from(lotteries).where(eq(lotteries.id, targetLotteryId));
    expect(target.purchaseDeadlineAt).toBeNull();
  });

  it("当選発表のみの短い後続投稿（結果待ちボーナス）も更新候補になる", async () => {
    const sp1 = await insertSourcePost(`scenario-c-original-${Date.now()}`);
    const productName = `本命商品C-${Date.now()}`;
    const original = toLotteryRow(sp1, makeLottery({ productNameRaw: productName }));
    await syncLotteriesFromAnalysis(db, sp1, [original]);

    const sp2 = await insertSourcePost(`scenario-c-followup-${Date.now()}`);
    const followup = toLotteryRow(
      sp2,
      makeLottery({
        productNameRaw: productName,
        applicationEnd: { at: null, date: null, precision: "unknown", status: "ok" }, // 締切再掲なし
        resultAnnouncement: { at: null, date: "2026-08-25", precision: "date_only", status: "ok" },
      })
    );
    const result = await syncLotteriesFromAnalysis(db, sp2, [followup]);

    expect(result.results[0].matchAction).toBe("candidate");
  });
});

describe("(d) 類似商品でも店舗・締切が異なれば新規", () => {
  it("商品名が同じでも店舗・締切が両方異なれば低スコアとなり新規lotteryとして扱われる", async () => {
    // 商品名の完全一致(40点)だけでは更新候補（review閾値50）に届かないよう、
    // 締切も異なる（=締切スコア0点）ケースで検証する（店舗名だけを変えると締切一致で
    // 55点になり有力候補と判定される、というscorePairの仕様は matchExistingLottery.test.ts で別途検証済み）。
    const sp1 = await insertSourcePost(`scenario-d-original-${Date.now()}`);
    const productName = `商品D-${Date.now()}`;
    const original = toLotteryRow(
      sp1,
      makeLottery({
        productNameRaw: productName,
        storeNameRaw: "店舗X",
        applicationEnd: { at: null, date: "2026-08-20", precision: "date_only", status: "ok" },
      })
    );
    await syncLotteriesFromAnalysis(db, sp1, [original]);

    const sp2 = await insertSourcePost(`scenario-d-other-${Date.now()}`);
    const other = toLotteryRow(
      sp2,
      makeLottery({
        productNameRaw: productName,
        storeNameRaw: "店舗Y（全く別）",
        applicationEnd: { at: null, date: "2026-11-30", precision: "date_only", status: "ok" },
      })
    );
    const result = await syncLotteriesFromAnalysis(db, sp2, [other]);

    expect(result.results[0].matchAction).toBe("new");
  });
});

describe("(e) 1投稿に2抽選 → ちょうど2件の候補/新規行になる", () => {
  it("同じ投稿から2つの既存抽選にマッチする場合、2件の独立した更新候補が作られる", async () => {
    const spA = await insertSourcePost(`scenario-e-existing-a-${Date.now()}`);
    const productA = `複数抽選A-${Date.now()}`;
    await syncLotteriesFromAnalysis(db, spA, [toLotteryRow(spA, makeLottery({ productNameRaw: productA, storeNameRaw: "店舗A" }))]);

    const spB = await insertSourcePost(`scenario-e-existing-b-${Date.now()}`);
    const productB = `複数抽選B-${Date.now()}`;
    await syncLotteriesFromAnalysis(db, spB, [toLotteryRow(spB, makeLottery({ productNameRaw: productB, storeNameRaw: "店舗B" }))]);

    const spSummary = await insertSourcePost(`scenario-e-summary-${Date.now()}`);
    const splitCandidates = [
      toLotteryRow(spSummary, makeLottery({ productNameRaw: productA, storeNameRaw: "店舗A" })),
      toLotteryRow(spSummary, makeLottery({ productNameRaw: productB, storeNameRaw: "店舗B" })),
    ];
    const result = await syncLotteriesFromAnalysis(db, spSummary, splitCandidates);

    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.matchAction === "candidate")).toBe(true);
    expect(new Set(result.results.map((r) => r.candidateId))).toEqual(
      new Set([result.results[0].candidateId, result.results[1].candidateId])
    );
    expect(result.results[0].candidateId).not.toBe(result.results[1].candidateId);

    const rows = await db.select().from(lotteryUpdateCandidates).where(eq(lotteryUpdateCandidates.sourcePostId, spSummary));
    expect(rows).toHaveLength(2);
  });
});

describe("(f) 同一externalPostIdの再処理では候補が重複しない", () => {
  it("同じsourcePostIdで同じ内容を2回同期しても候補は1件のまま更新される", async () => {
    const sp1 = await insertSourcePost(`scenario-f-original-${Date.now()}`);
    const productName = `重複防止商品F-${Date.now()}`;
    await syncLotteriesFromAnalysis(db, sp1, [toLotteryRow(sp1, makeLottery({ productNameRaw: productName }))]);

    const sp2 = await insertSourcePost(`scenario-f-followup-${Date.now()}`);
    const followup = toLotteryRow(sp2, makeLottery({ productNameRaw: productName, applicationMethod: "リプライ" }));

    const first = await syncLotteriesFromAnalysis(db, sp2, [followup]);
    const second = await syncLotteriesFromAnalysis(db, sp2, [followup]); // 同じsourcePostIdでの再実行（parserVersion再解析を模す）

    expect(first.results[0].candidateId).toBe(second.results[0].candidateId);
    const rows = await db.select().from(lotteryUpdateCandidates).where(eq(lotteryUpdateCandidates.sourcePostId, sp2));
    expect(rows).toHaveLength(1);
  });
});

describe("(g) parserVersion再解析でも承認済みlotteryは完全に不変", () => {
  it("承認済みlotteryをターゲットとする候補が繰り返し再解析されても、既存lotteryは一切変更されない", async () => {
    const sp1 = await insertSourcePost(`scenario-g-original-${Date.now()}`);
    const productName = `承認済み商品G-${Date.now()}`;
    const firstResult = await syncLotteriesFromAnalysis(db, sp1, [toLotteryRow(sp1, makeLottery({ productNameRaw: productName }))]);
    const targetId = firstResult.results[0].lotteryId!;
    await db.update(lotteries).set({ verificationStatus: "approved", approvedBy: "admin" }).where(eq(lotteries.id, targetId));

    const sp2 = await insertSourcePost(`scenario-g-followup-${Date.now()}`);
    const followup = toLotteryRow(sp2, makeLottery({ productNameRaw: productName, applicationMethod: "DM" }));
    await syncLotteriesFromAnalysis(db, sp2, [followup]);
    await syncLotteriesFromAnalysis(db, sp2, [followup]); // 再解析を模した再実行

    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, targetId));
    expect(row.verificationStatus).toBe("approved");
    expect(row.applicationMethod).toBeNull();
  });
});

describe("(h) 無視した候補は再解析で復活しない", () => {
  it("ignoreした候補は同じ内容で再同期しても状態が変わらない", async () => {
    const sp1 = await insertSourcePost(`scenario-h-original-${Date.now()}`);
    const productName = `無視候補商品H-${Date.now()}`;
    await syncLotteriesFromAnalysis(db, sp1, [toLotteryRow(sp1, makeLottery({ productNameRaw: productName }))]);

    const sp2 = await insertSourcePost(`scenario-h-followup-${Date.now()}`);
    const followup = toLotteryRow(sp2, makeLottery({ productNameRaw: productName }));
    const result = await syncLotteriesFromAnalysis(db, sp2, [followup]);
    const candidateId = result.results[0].candidateId!;

    await ignoreLotteryUpdateCandidate(db, candidateId, "admin@example.com");

    const reanalyzed = await syncLotteriesFromAnalysis(db, sp2, [followup]);
    expect(reanalyzed.results[0].candidateId).toBe(candidateId);
    expect(reanalyzed.candidates).toBe(0); // skipped_resolvedなのでカウントされない

    const row = await getLotteryUpdateCandidateById(db, candidateId);
    expect(row?.status).toBe("ignored");
  });
});

describe("candidate_key の衝突対策: 同一投稿内に商品名・店舗名が完全一致する項目が複数ある場合", () => {
  it("2件とも候補として保持され、後の項目が前の項目を上書きしない", async () => {
    const spExisting = await insertSourcePost(`scenario-collision-existing-${Date.now()}`);
    const productName = `重複商品-${Date.now()}`;
    const storeName = "重複店舗";
    await syncLotteriesFromAnalysis(db, spExisting, [
      toLotteryRow(spExisting, makeLottery({ productNameRaw: productName, storeNameRaw: storeName })),
    ]);

    // 1つの投稿の中に、商品名・店舗名が完全に同じ（しかし別枠の）抽選が2件含まれるケース
    // （同名店舗の複数枠・まとめ投稿内の表記重複等、実データ上は稀だが起こりうる）。
    const spSummary = await insertSourcePost(`scenario-collision-summary-${Date.now()}`);
    const dup1 = toLotteryRow(spSummary, makeLottery({ productNameRaw: productName, storeNameRaw: storeName, applicationMethod: "枠1" }));
    const dup2 = toLotteryRow(spSummary, makeLottery({ productNameRaw: productName, storeNameRaw: storeName, applicationMethod: "枠2" }));
    const result = await syncLotteriesFromAnalysis(db, spSummary, [dup1, dup2]);

    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.matchAction === "candidate")).toBe(true);
    // 衝突していれば2件目のupsertが1件目の行を更新してcandidateIdが同じになる（=バグ）。
    expect(result.results[0].candidateId).not.toBe(result.results[1].candidateId);

    const rows = await db
      .select()
      .from(lotteryUpdateCandidates)
      .where(eq(lotteryUpdateCandidates.sourcePostId, spSummary));
    expect(rows).toHaveLength(2); // 1件に潰れていない
    // candidateKeyも一意化されている（2件目に#2サフィックスが付く）
    expect(new Set(rows.map((r) => r.candidateKey)).size).toBe(2);
    // データが失われていない（枠1・枠2それぞれの内容が別々に保持されている）
    const methods = rows.map((r) => (JSON.parse(r.extractedData) as { applicationMethod: string | null }).applicationMethod).sort();
    expect(methods).toEqual(["枠1", "枠2"]);
  });
});

describe("(i) 反映済みの候補は再解析で重複生成されない", () => {
  it("applyした候補は同じ内容で再同期しても新しい候補が作られない", async () => {
    const sp1 = await insertSourcePost(`scenario-i-original-${Date.now()}`);
    const productName = `反映済み商品I-${Date.now()}`;
    await syncLotteriesFromAnalysis(db, sp1, [toLotteryRow(sp1, makeLottery({ productNameRaw: productName, region: null }))]);

    const sp2 = await insertSourcePost(`scenario-i-followup-${Date.now()}`);
    const followup = toLotteryRow(sp2, makeLottery({ productNameRaw: productName, region: "関西" }));
    const result = await syncLotteriesFromAnalysis(db, sp2, [followup]);
    const candidateId = result.results[0].candidateId!;

    await applyLotteryUpdateCandidate(db, candidateId, ["region"], "admin@example.com");

    const reanalyzed = await syncLotteriesFromAnalysis(db, sp2, [followup]);
    expect(reanalyzed.results[0].candidateId).toBe(candidateId);
    expect(reanalyzed.candidates).toBe(0);

    const rows = await db.select().from(lotteryUpdateCandidates).where(eq(lotteryUpdateCandidates.sourcePostId, sp2));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("applied");
  });
});
