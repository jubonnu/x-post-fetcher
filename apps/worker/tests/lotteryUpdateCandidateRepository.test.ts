import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { lotteries, lotteryFieldHistory, lotteryUpdateCandidates, sourcePosts } from "../src/db/schema.ts";
import {
  applyLotteryUpdateCandidate,
  getLotteryUpdateCandidateById,
  getLotteryUpdateCandidateDiff,
  ignoreLotteryUpdateCandidate,
  listLotteryUpdateCandidates,
  registerLotteryUpdateCandidateAsNew,
  upsertLotteryUpdateCandidate,
  type LotteryCandidateData,
} from "../src/repositories/lotteryUpdateCandidateRepository.ts";
import { buildLotteryUpdateCandidateKey } from "../src/services/lotteryUpdateCandidateKey.ts";

/** デフォルトの商品名・店舗名（"MEGAドリームex"/"ドラゴンスター"）から生成される候補キー。 */
const DEFAULT_CANDIDATE_KEY = buildLotteryUpdateCandidateKey({
  normalizedProductName: "MEGAドリームex",
  normalizedStoreName: "ドラゴンスター",
  candidateIndex: 0,
});

const DB_FILE = resolve(process.cwd(), `.tmp-lottery-update-candidates-${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
});

afterAll(() => {
  rmSync(DB_FILE);
});

async function insertSourcePost(externalPostId: string): Promise<number> {
  const [row] = await db.insert(sourcePosts).values({ externalPostId }).returning();
  return row.id;
}

async function insertLottery(overrides: Partial<typeof lotteries.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(lotteries)
    .values({
      productNameRaw: "MEGAドリームex",
      normalizedProductName: "MEGAドリームex",
      storeNameRaw: "ドラゴンスター",
      normalizedStoreName: "ドラゴンスター",
      verificationStatus: "extracted",
      ...overrides,
    })
    .returning();
  return row.id;
}

function makeExtractedData(overrides: Partial<LotteryCandidateData> = {}): LotteryCandidateData {
  return {
    sourcePostId: 0,
    productNameRaw: "MEGAドリームex",
    normalizedProductName: "MEGAドリームex",
    cardType: "pokemon",
    storeNameRaw: "ドラゴンスター",
    normalizedStoreName: "ドラゴンスター",
    storeBranchRaw: null,
    normalizedStoreBranch: null,
    region: null,
    normalizerVersion: "phase2-norm-1",
    applicationStartAt: null,
    confirmedOpenAt: null,
    applicationEndAt: null,
    applicationEndDate: null,
    applicationEndPrecision: "unknown",
    resultAnnouncementStartAt: null,
    resultAnnouncementAt: null,
    resultAnnouncementDate: null,
    resultAnnouncementPrecision: "unknown",
    purchaseStartAt: null,
    purchaseDeadlineAt: null,
    applicationUrl: null,
    applicationUrls: null,
    officialInformationUrl: null,
    appDownloadUrl: null,
    applicationMethod: null,
    eligibilityConditions: null,
    pickupMethod: null,
    paymentMethod: null,
    price: null,
    status: "open",
    completenessScore: "0.5",
    verificationStatus: "extracted",
    ...overrides,
  } as LotteryCandidateData;
}

describe("upsertLotteryUpdateCandidate", () => {
  it("未存在なら新規挿入する", async () => {
    const sourcePostId = await insertSourcePost("cand-insert-1");
    const targetLotteryId = await insertLottery();
    const r = await upsertLotteryUpdateCandidate(db, {
      targetLotteryId,
      sourcePostId,
      candidateIndex: 0,
      candidateKey: DEFAULT_CANDIDATE_KEY,
      matchScore: 65,
      matchReason: "score_review",
      extractedData: makeExtractedData({ sourcePostId }),
    });
    expect(r.action).toBe("inserted");

    const row = await getLotteryUpdateCandidateById(db, r.id);
    expect(row?.status).toBe("pending");
    expect(row?.targetLotteryId).toBe(targetLotteryId);
  });

  it("同じsourcePostId+candidateKeyで再解析するとpendingなら内容が更新される（重複挿入しない）", async () => {
    const sourcePostId = await insertSourcePost("cand-update-1");
    const targetA = await insertLottery();
    const targetB = await insertLottery();

    const first = await upsertLotteryUpdateCandidate(db, {
      targetLotteryId: targetA,
      sourcePostId,
      candidateIndex: 0,
      candidateKey: DEFAULT_CANDIDATE_KEY,
      matchScore: 60,
      matchReason: "score_review",
      extractedData: makeExtractedData({ sourcePostId }),
    });
    expect(first.action).toBe("inserted");

    const second = await upsertLotteryUpdateCandidate(db, {
      targetLotteryId: targetB,
      sourcePostId,
      candidateIndex: 0,
      candidateKey: DEFAULT_CANDIDATE_KEY,
      matchScore: 90,
      matchReason: "score_merge",
      extractedData: makeExtractedData({ sourcePostId, purchaseDeadlineAt: "2026-08-30T00:00:00.000Z" }),
    });
    expect(second.action).toBe("updated");
    expect(second.id).toBe(first.id);

    const row = await getLotteryUpdateCandidateById(db, first.id);
    expect(row?.targetLotteryId).toBe(targetB);
    expect(row?.matchScore).toBe("90");

    const all = await db.select().from(lotteryUpdateCandidates).where(eq(lotteryUpdateCandidates.sourcePostId, sourcePostId));
    expect(all).toHaveLength(1);
  });

  it("解決済み（pending以外）の候補は再解析で復活・変更されない", async () => {
    const sourcePostId = await insertSourcePost("cand-resolved-1");
    const targetLotteryId = await insertLottery();

    const inserted = await upsertLotteryUpdateCandidate(db, {
      targetLotteryId,
      sourcePostId,
      candidateIndex: 0,
      candidateKey: DEFAULT_CANDIDATE_KEY,
      matchScore: 60,
      matchReason: "score_review",
      extractedData: makeExtractedData({ sourcePostId }),
    });
    const ignored = await ignoreLotteryUpdateCandidate(db, inserted.id, "admin@example.com");
    expect(ignored).toEqual({ ok: true });

    const after = await upsertLotteryUpdateCandidate(db, {
      targetLotteryId,
      sourcePostId,
      candidateIndex: 0,
      candidateKey: DEFAULT_CANDIDATE_KEY,
      matchScore: 95,
      matchReason: "score_merge",
      extractedData: makeExtractedData({ sourcePostId, purchaseDeadlineAt: "2026-09-01T00:00:00.000Z" }),
    });
    expect(after.action).toBe("skipped_resolved");

    const row = await getLotteryUpdateCandidateById(db, inserted.id);
    expect(row?.status).toBe("ignored");
    expect(row?.matchScore).toBe("60"); // 変更されていない
  });

  it("1投稿が複数抽選に分割された場合、商品名・店舗名が異なれば別々の候補行になる", async () => {
    const sourcePostId = await insertSourcePost("cand-split-1");
    const target = await insertLottery();

    const a = await upsertLotteryUpdateCandidate(db, {
      targetLotteryId: target,
      sourcePostId,
      candidateIndex: 0,
      candidateKey: buildLotteryUpdateCandidateKey({ normalizedProductName: "商品A", normalizedStoreName: "ドラゴンスター", candidateIndex: 0 }),
      matchScore: 60,
      matchReason: "score_review",
      extractedData: makeExtractedData({ sourcePostId, normalizedProductName: "商品A" }),
    });
    const b = await upsertLotteryUpdateCandidate(db, {
      targetLotteryId: target,
      sourcePostId,
      candidateIndex: 1,
      candidateKey: buildLotteryUpdateCandidateKey({ normalizedProductName: "商品B", normalizedStoreName: "ドラゴンスター", candidateIndex: 1 }),
      matchScore: 60,
      matchReason: "score_review",
      extractedData: makeExtractedData({ sourcePostId, normalizedProductName: "商品B" }),
    });
    expect(a.id).not.toBe(b.id);

    const all = await db.select().from(lotteryUpdateCandidates).where(eq(lotteryUpdateCandidates.sourcePostId, sourcePostId));
    expect(all).toHaveLength(2);
  });
});

describe("listLotteryUpdateCandidates", () => {
  it("statusで絞り込める", async () => {
    const sourcePostId = await insertSourcePost("cand-list-1");
    const target = await insertLottery();
    const inserted = await upsertLotteryUpdateCandidate(db, {
      targetLotteryId: target,
      sourcePostId,
      candidateIndex: 0,
      candidateKey: DEFAULT_CANDIDATE_KEY,
      matchScore: 60,
      matchReason: "score_review",
      extractedData: makeExtractedData({ sourcePostId }),
    });

    const pendingList = await listLotteryUpdateCandidates(db, { status: "pending" });
    expect(pendingList.candidates.some((c) => c.id === inserted.id)).toBe(true);

    const ignoredList = await listLotteryUpdateCandidates(db, { status: "ignored" });
    expect(ignoredList.candidates.some((c) => c.id === inserted.id)).toBe(false);
  });
});

describe("getLotteryUpdateCandidateDiff", () => {
  it("追加可能・競合・一致フィールドを正しく分類する", async () => {
    const sourcePostId = await insertSourcePost("cand-diff-1");
    const target = await insertLottery({
      normalizedProductName: "MEGAドリームex",
      normalizedStoreName: "ドラゴンスター",
      region: null, // 既存が空 → 追加可能になるはず
      applicationUrl: "https://forms.gle/existing",
      applicationEndDate: "2026-08-20",
      applicationEndPrecision: "date_only",
    });

    const inserted = await upsertLotteryUpdateCandidate(db, {
      targetLotteryId: target,
      sourcePostId,
      candidateIndex: 0,
      candidateKey: DEFAULT_CANDIDATE_KEY,
      matchScore: 70,
      matchReason: "score_review",
      extractedData: makeExtractedData({
        sourcePostId,
        region: "関西", // 既存空 → addable
        applicationUrl: "https://forms.gle/new", // 既存あり・異なる → conflicting
      }),
    });

    const diff = await getLotteryUpdateCandidateDiff(db, inserted.id);
    expect(diff).not.toBeNull();
    expect(diff!.addableFields.map((f) => f.fieldName)).toContain("region");
    expect(diff!.conflictingFields.map((f) => f.fieldName)).toContain("applicationUrl");
    expect(diff!.matchingFields).toContain("normalizedProductName");
    expect(diff!.matchingFields).toContain("normalizedStoreName");
  });
});

describe("applyLotteryUpdateCandidate", () => {
  it("選択したフィールドだけを既存抽選へ反映し、他は変更しない", async () => {
    const sourcePostId = await insertSourcePost("cand-apply-1");
    const target = await insertLottery({
      normalizedProductName: "MEGAドリームex",
      normalizedStoreName: "ドラゴンスター",
      region: null,
      applicationUrl: "https://forms.gle/existing",
    });

    const inserted = await upsertLotteryUpdateCandidate(db, {
      targetLotteryId: target,
      sourcePostId,
      candidateIndex: 0,
      candidateKey: DEFAULT_CANDIDATE_KEY,
      matchScore: 70,
      matchReason: "score_review",
      extractedData: makeExtractedData({
        sourcePostId,
        region: "関西",
        applicationUrl: "https://forms.gle/new",
      }),
    });

    const result = await applyLotteryUpdateCandidate(db, inserted.id, ["region"], "admin@example.com");
    expect(result).toMatchObject({ ok: true, appliedFields: ["region"] });

    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, target));
    expect(row.region).toBe("関西");
    // applicationUrlは選択しなかったので既存のまま
    expect(row.applicationUrl).toBe("https://forms.gle/existing");

    const history = await db.select().from(lotteryFieldHistory).where(eq(lotteryFieldHistory.lotteryId, target));
    expect(history.some((h) => h.fieldName === "region" && h.changeType === "updated")).toBe(true);

    const candidateRow = await getLotteryUpdateCandidateById(db, inserted.id);
    expect(candidateRow?.status).toBe("applied");
    expect(candidateRow?.resolvedBy).toBe("admin@example.com");

    // 解決済みなので再度applyはできない
    const second = await applyLotteryUpdateCandidate(db, inserted.id, ["region"], "admin@example.com");
    expect(second).toBe("candidate_already_resolved");
  });

  it("選択したフィールドが0件ならno_fields_selected", async () => {
    const sourcePostId = await insertSourcePost("cand-apply-2");
    const target = await insertLottery();
    const inserted = await upsertLotteryUpdateCandidate(db, {
      targetLotteryId: target,
      sourcePostId,
      candidateIndex: 0,
      candidateKey: DEFAULT_CANDIDATE_KEY,
      matchScore: 70,
      matchReason: "score_review",
      extractedData: makeExtractedData({ sourcePostId }),
    });
    const result = await applyLotteryUpdateCandidate(db, inserted.id, [], "admin@example.com");
    expect(result).toBe("no_fields_selected");
  });
});

describe("registerLotteryUpdateCandidateAsNew", () => {
  it("抽出データをそのまま新規lotteryとして登録し、候補をregistered_as_newにする", async () => {
    const sourcePostId = await insertSourcePost("cand-register-1");
    const target = await insertLottery();
    const inserted = await upsertLotteryUpdateCandidate(db, {
      targetLotteryId: target,
      sourcePostId,
      candidateIndex: 0,
      candidateKey: buildLotteryUpdateCandidateKey({ normalizedProductName: "別の商品", normalizedStoreName: "ドラゴンスター", candidateIndex: 0 }),
      matchScore: 55,
      matchReason: "score_review",
      extractedData: makeExtractedData({ sourcePostId, normalizedProductName: "別の商品" }),
    });

    const result = await registerLotteryUpdateCandidateAsNew(db, inserted.id, "admin@example.com");
    expect(result).toHaveProperty("ok", true);
    const lotteryId = (result as { ok: true; lotteryId: number }).lotteryId;
    expect(lotteryId).not.toBe(target);

    const [newLottery] = await db.select().from(lotteries).where(eq(lotteries.id, lotteryId));
    expect(newLottery.normalizedProductName).toBe("別の商品");

    const candidateRow = await getLotteryUpdateCandidateById(db, inserted.id);
    expect(candidateRow?.status).toBe("registered_as_new");
    expect(candidateRow?.registeredLotteryId).toBe(lotteryId);

    const second = await registerLotteryUpdateCandidateAsNew(db, inserted.id, "admin@example.com");
    expect(second).toBe("candidate_already_resolved");
  });
});

describe("ignoreLotteryUpdateCandidate", () => {
  it("既存抽選には一切触れずstatusをignoredにする", async () => {
    const sourcePostId = await insertSourcePost("cand-ignore-1");
    const target = await insertLottery({ region: "関東" });
    const inserted = await upsertLotteryUpdateCandidate(db, {
      targetLotteryId: target,
      sourcePostId,
      candidateIndex: 0,
      candidateKey: DEFAULT_CANDIDATE_KEY,
      matchScore: 55,
      matchReason: "score_review",
      extractedData: makeExtractedData({ sourcePostId, region: "関西" }),
    });

    const result = await ignoreLotteryUpdateCandidate(db, inserted.id, "admin@example.com");
    expect(result).toEqual({ ok: true });

    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, target));
    expect(row.region).toBe("関東"); // 変更されない

    const candidateRow = await getLotteryUpdateCandidateById(db, inserted.id);
    expect(candidateRow?.status).toBe("ignored");
  });
});
