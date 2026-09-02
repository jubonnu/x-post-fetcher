/**
 * 管理画面「更新候補」タブ（/admin/lottery-update-candidates/*）の結合テスト（Phase 11）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { lotteries, postAnalyses, sourcePosts } from "../src/db/schema.ts";
import { upsertLotteryUpdateCandidate, type LotteryCandidateData } from "../src/repositories/lotteryUpdateCandidateRepository.ts";
import { buildLotteryUpdateCandidateKey } from "../src/services/lotteryUpdateCandidateKey.ts";
import { MANUAL_INGEST_PARSER_VERSION } from "../src/services/claudeIngestTransform.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-admin-update-candidates-${Date.now()}.db`);

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.ADMIN_INVITE_CODE = "test-invite-code";
process.env.ADMIN_JWT_SECRET = "test-admin-jwt-secret-not-for-production";

let app: ReturnType<typeof createApp>;
const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  app = createApp(createDb);
});

afterAll(() => {
  rmSync(DB_FILE);
});

let adminToken: string;

beforeAll(async () => {
  const res = await app.request("/admin/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "candidates-admin@example.com", password: "password123", inviteCode: "test-invite-code" }),
  });
  const body = (await res.json()) as { token: string };
  adminToken = body.token;
});

function authHeaders() {
  return { Authorization: `Bearer ${adminToken}` };
}
function jsonAuthHeaders() {
  return { "Content-Type": "application/json", ...authHeaders() };
}

async function insertSourcePost(
  externalPostId: string,
  overrides: Partial<typeof sourcePosts.$inferInsert> = {}
): Promise<number> {
  const [row] = await db.insert(sourcePosts).values({ externalPostId, ...overrides }).returning();
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

function makeExtractedData(sourcePostId: number, overrides: Partial<LotteryCandidateData> = {}): LotteryCandidateData {
  return {
    sourcePostId,
    productNameRaw: "MEGAドリームex",
    normalizedProductName: "MEGAドリームex",
    cardType: "pokemon",
    storeNameRaw: "ドラゴンスター",
    normalizedStoreName: "ドラゴンスター",
    storeBranchRaw: null,
    normalizedStoreBranch: null,
    region: "関西",
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

async function createPendingCandidate(
  sourcePostOverrides: Partial<typeof sourcePosts.$inferInsert> = {}
): Promise<{ candidateId: number; targetLotteryId: number; sourcePostId: number }> {
  const sourcePostId = await insertSourcePost(`cand-route-${Date.now()}-${Math.random()}`, sourcePostOverrides);
  const targetLotteryId = await insertLottery({ region: null });
  const upserted = await upsertLotteryUpdateCandidate(db, {
    targetLotteryId,
    sourcePostId,
    candidateIndex: 0,
    candidateKey: buildLotteryUpdateCandidateKey({
      normalizedProductName: "MEGAドリームex",
      normalizedStoreName: "ドラゴンスター",
      candidateIndex: 0,
    }),
    matchScore: 70,
    matchReason: "score_review",
    extractedData: makeExtractedData(sourcePostId),
  });
  return { candidateId: upserted.id, targetLotteryId, sourcePostId };
}

async function insertPostAnalysis(sourcePostId: number, parserVersion: string): Promise<void> {
  await db.insert(postAnalyses).values({ sourcePostId, parserVersion });
}

describe("GET /admin/lottery-update-candidates", () => {
  it("認証無しは401", async () => {
    const res = await app.request("/admin/lottery-update-candidates");
    expect(res.status).toBe(401);
  });

  it("一覧にpendingの候補が含まれる", async () => {
    const { candidateId } = await createPendingCandidate();
    const res = await app.request("/admin/lottery-update-candidates?status=pending", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: number }[]; total: number };
    expect(body.items.some((i) => i.id === candidateId)).toBe(true);
  });

  it("元投稿のX投稿日時（sourcePostPublishedAt）を含む", async () => {
    const publishedAt = "2026-08-15T12:34:00.000Z";
    const { candidateId } = await createPendingCandidate({ publishedAt });
    const res = await app.request("/admin/lottery-update-candidates?status=pending", { headers: authHeaders() });
    const body = (await res.json()) as { items: { id: number; sourcePostPublishedAt: string | null }[] };
    const item = body.items.find((i) => i.id === candidateId);
    expect(item?.sourcePostPublishedAt).toBe(publishedAt);
  });

  it("元投稿にpublishedAtが無ければnullを返す", async () => {
    const { candidateId } = await createPendingCandidate();
    const res = await app.request("/admin/lottery-update-candidates?status=pending", { headers: authHeaders() });
    const body = (await res.json()) as { items: { id: number; sourcePostPublishedAt: string | null }[] };
    const item = body.items.find((i) => i.id === candidateId);
    expect(item?.sourcePostPublishedAt).toBeNull();
  });
});

describe("GET /admin/lottery-update-candidates/:id", () => {
  it("既存抽選との差分（追加可能/一致フィールド）を返す", async () => {
    const { candidateId } = await createPendingCandidate();
    const res = await app.request(`/admin/lottery-update-candidates/${candidateId}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      addableFields: { fieldName: string }[];
      matchingFields: string[];
      targetLottery: { id: number } | null;
      newSourcePost: { id: number } | null;
      existingSourcePost: { id: number } | null;
    };
    expect(body.addableFields.some((f) => f.fieldName === "region")).toBe(true);
    expect(body.matchingFields).toContain("normalizedProductName");
    expect(body.targetLottery).not.toBeNull();
    expect(body.newSourcePost).not.toBeNull();
  });

  it("存在しないidは404", async () => {
    const res = await app.request("/admin/lottery-update-candidates/999999", { headers: authHeaders() });
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/lottery-update-candidates/:id/apply", () => {
  it("選択したフィールドだけを既存抽選へ反映する", async () => {
    const { candidateId, targetLotteryId } = await createPendingCandidate();

    const res = await app.request(`/admin/lottery-update-candidates/${candidateId}/apply`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ fields: ["region"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; appliedFields: string[] };
    expect(body.appliedFields).toEqual(["region"]);

    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, targetLotteryId));
    expect(row.region).toBe("関西");
  });

  it("fieldsが空配列なら422", async () => {
    const { candidateId } = await createPendingCandidate();
    const res = await app.request(`/admin/lottery-update-candidates/${candidateId}/apply`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ fields: [] }),
    });
    expect(res.status).toBe(422);
  });

  it("既に処理済みの候補への再applyは422", async () => {
    const { candidateId } = await createPendingCandidate();
    await app.request(`/admin/lottery-update-candidates/${candidateId}/apply`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ fields: ["region"] }),
    });
    const second = await app.request(`/admin/lottery-update-candidates/${candidateId}/apply`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ fields: ["region"] }),
    });
    expect(second.status).toBe(422);
  });
});

describe("POST /admin/lottery-update-candidates/:id/register-as-new", () => {
  it("別抽選として新規登録する", async () => {
    const { candidateId } = await createPendingCandidate();
    const res = await app.request(`/admin/lottery-update-candidates/${candidateId}/register-as-new`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; lotteryId: number };
    expect(body.lotteryId).toBeTypeOf("number");
  });
});

describe("POST /admin/lottery-update-candidates/:id/ignore", () => {
  it("既存抽選に触れずignoredにする", async () => {
    const { candidateId, targetLotteryId } = await createPendingCandidate();
    const res = await app.request(`/admin/lottery-update-candidates/${candidateId}/ignore`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, targetLotteryId));
    expect(row.region).toBeNull();
  });
});

describe("POST /admin/lottery-update-candidates/:id/auto-resolve", () => {
  it("未認証は401", async () => {
    const { candidateId } = await createPendingCandidate();
    const res = await app.request(`/admin/lottery-update-candidates/${candidateId}/auto-resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(401);
  });

  it("存在しないidは404", async () => {
    const res = await app.request("/admin/lottery-update-candidates/999999/auto-resolve", {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(404);
  });

  it("dryRun=trueは判定のみ行い、DBには反映しない", async () => {
    const { candidateId, targetLotteryId } = await createPendingCandidate();
    const res = await app.request(`/admin/lottery-update-candidates/${candidateId}/auto-resolve`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: boolean; decision: { action: string } };
    expect(body.applied).toBe(false);
    expect(body.decision.action).toBe("apply"); // regionがaddableなので判定自体はapply

    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, targetLotteryId));
    expect(row.region).toBeNull(); // 実際には反映されていない
  });

  it("addableFieldsのみ（overwritable無し）は自動でapplyされる", async () => {
    const { candidateId, targetLotteryId } = await createPendingCandidate();
    const res = await app.request(`/admin/lottery-update-candidates/${candidateId}/auto-resolve`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ dryRun: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: boolean; decision: { action: string; reason: string } };
    expect(body.applied).toBe(true);
    expect(body.decision).toMatchObject({ action: "apply", reason: "addable_only" });

    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, targetLotteryId));
    expect(row.region).toBe("関西");
  });

  it("完全一致（差分無し）は自動でignoreされる", async () => {
    const sourcePostId = await insertSourcePost(`cand-exact-${Date.now()}-${Math.random()}`);
    // makeExtractedDataの既定値と完全一致させる（cardType: "pokemon"もmakeExtractedDataの既定値）。
    const targetLotteryId = await insertLottery({ cardType: "pokemon" });
    const upserted = await upsertLotteryUpdateCandidate(db, {
      targetLotteryId,
      sourcePostId,
      candidateIndex: 0,
      candidateKey: buildLotteryUpdateCandidateKey({
        normalizedProductName: "MEGAドリームex",
        normalizedStoreName: "ドラゴンスター",
        candidateIndex: 0,
      }),
      matchScore: 70,
      matchReason: "score_review",
      extractedData: makeExtractedData(sourcePostId, { region: null }),
    });

    const res = await app.request(`/admin/lottery-update-candidates/${upserted.id}/auto-resolve`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ dryRun: false }),
    });
    const body = (await res.json()) as { applied: boolean; decision: { action: string; reason: string } };
    expect(body.decision).toEqual({ action: "ignore", fields: [], reason: "no_changes" });
    expect(body.applied).toBe(true);
  });

  it("overwritableFieldsがあり、regexパイプライン由来（Claude由来でない）ならskipされ、pendingのまま", async () => {
    const sourcePostId = await insertSourcePost(`cand-overwrite-regex-${Date.now()}-${Math.random()}`);
    await insertPostAnalysis(sourcePostId, "phase3-rules-15");
    const targetLotteryId = await insertLottery({
      applicationEndDate: "2026-09-06",
      applicationEndPrecision: "date_only",
    });
    const upserted = await upsertLotteryUpdateCandidate(db, {
      targetLotteryId,
      sourcePostId,
      candidateIndex: 0,
      candidateKey: buildLotteryUpdateCandidateKey({
        normalizedProductName: "MEGAドリームex",
        normalizedStoreName: "ドラゴンスター",
        candidateIndex: 0,
      }),
      matchScore: 70,
      matchReason: "score_review",
      extractedData: makeExtractedData(sourcePostId, {
        region: null,
        applicationEndAt: "2026-09-06T20:00:00+09:00",
        applicationEndDate: "2026-09-06",
        applicationEndPrecision: "datetime",
      }),
    });

    const res = await app.request(`/admin/lottery-update-candidates/${upserted.id}/auto-resolve`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ dryRun: false }),
    });
    const body = (await res.json()) as { applied: boolean; decision: { action: string; reason: string } };
    expect(body.decision).toMatchObject({ action: "skip", reason: "overwrite_requires_claude_source" });
    expect(body.applied).toBe(false);

    const [candidateRow] = await db
      .select()
      .from(lotteries)
      .where(eq(lotteries.id, targetLotteryId));
    expect(candidateRow.applicationEndPrecision).toBe("date_only"); // 未変更
  });

  it("overwritableFieldsがあり、Claude in Chrome由来なら自動でapplyされる（既存の日付精度を上書き）", async () => {
    const sourcePostId = await insertSourcePost(`cand-overwrite-claude-${Date.now()}-${Math.random()}`);
    await insertPostAnalysis(sourcePostId, MANUAL_INGEST_PARSER_VERSION);
    const targetLotteryId = await insertLottery({
      cardType: "pokemon",
      applicationEndDate: "2026-09-06",
      applicationEndPrecision: "date_only",
    });
    const upserted = await upsertLotteryUpdateCandidate(db, {
      targetLotteryId,
      sourcePostId,
      candidateIndex: 0,
      candidateKey: buildLotteryUpdateCandidateKey({
        normalizedProductName: "MEGAドリームex",
        normalizedStoreName: "ドラゴンスター",
        candidateIndex: 0,
      }),
      matchScore: 70,
      matchReason: "score_review",
      // regionは明示的にオーバーライドしない（makeExtractedDataの既定値"関西"のまま = addable扱いにする）
      extractedData: makeExtractedData(sourcePostId, {
        applicationEndAt: "2026-09-06T20:00:00+09:00",
        applicationEndDate: "2026-09-06",
        applicationEndPrecision: "datetime",
      }),
    });

    const res = await app.request(`/admin/lottery-update-candidates/${upserted.id}/auto-resolve`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ dryRun: false }),
    });
    const body = (await res.json()) as { applied: boolean; decision: { action: string; reason: string } };
    expect(body.decision).toMatchObject({ action: "apply", reason: "claude_sourced_overwrite" });
    expect(body.applied).toBe(true);

    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, targetLotteryId));
    expect(row.applicationEndPrecision).toBe("datetime");
    expect(row.applicationEndAt).toBe("2026-09-06T20:00:00+09:00");
    expect(row.region).toBe("関西"); // addableも一緒に反映される
  });

  it("conflictingFieldsが1件でもあればskip（Claude由来でも）", async () => {
    const sourcePostId = await insertSourcePost(`cand-conflict-${Date.now()}-${Math.random()}`);
    await insertPostAnalysis(sourcePostId, MANUAL_INGEST_PARSER_VERSION);
    const targetLotteryId = await insertLottery({ storeNameRaw: "既存店舗", normalizedStoreName: "既存店舗" });
    const upserted = await upsertLotteryUpdateCandidate(db, {
      targetLotteryId,
      sourcePostId,
      candidateIndex: 0,
      candidateKey: buildLotteryUpdateCandidateKey({
        normalizedProductName: "MEGAドリームex",
        normalizedStoreName: "別の店舗",
        candidateIndex: 0,
      }),
      matchScore: 70,
      matchReason: "score_review",
      extractedData: makeExtractedData(sourcePostId, {
        region: null,
        storeNameRaw: "別の店舗",
        normalizedStoreName: "別の店舗",
      }),
    });

    const res = await app.request(`/admin/lottery-update-candidates/${upserted.id}/auto-resolve`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ dryRun: false }),
    });
    const body = (await res.json()) as { applied: boolean; decision: { action: string; reason: string } };
    expect(body.decision).toMatchObject({ action: "skip", reason: "has_conflicting_fields" });
    expect(body.applied).toBe(false);
  });

  it("既に処理済みの候補への再auto-resolveは422", async () => {
    const { candidateId } = await createPendingCandidate();
    await app.request(`/admin/lottery-update-candidates/${candidateId}/auto-resolve`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ dryRun: false }),
    });
    const second = await app.request(`/admin/lottery-update-candidates/${candidateId}/auto-resolve`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ dryRun: false }),
    });
    expect(second.status).toBe(422);
  });
});
