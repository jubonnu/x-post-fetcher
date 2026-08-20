import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";

/**
 * archivedAt（source_postsのアーカイブ状態）の要件検証:
 *   1. アーカイブ済みでも known IDs API では既知として返る（再取得ループを起こさない）
 *   2. アーカイブ済みはlottery解析・再解析の対象にしない（新規lottery/candidateを作らない）
 *   3. archive/unarchiveで状態を行き来でき、unarchive後は通常どおり解析される
 * （2026-08、stagingでsource_postsを物理削除→差分取得が再取得ループする事故を起こした
 *   ため、物理削除に代わる論理的な除外として導入）。
 */

const DB_FILE = resolve(process.cwd(), `.tmp-test-${Date.now()}-archive.db`);
const TOKEN = "test-token";

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.INGEST_TOKEN = TOKEN;

let app: ReturnType<typeof import("../src/app.ts")["createApp"]>;
let seq = 0;

function nextId(): string {
  seq += 1;
  return String(7000000 + seq);
}

function baseExtractedLottery(overrides: Record<string, unknown> = {}) {
  return {
    cardType: "pokemon",
    productNameRaw: null,
    storeNameRaw: null,
    storeBranchRaw: null,
    region: null,
    applicationStart: {},
    applicationEnd: {},
    resultAnnouncementStart: {},
    resultAnnouncement: {},
    purchaseStart: {},
    purchaseDeadline: {},
    confirmedOpenAt: null,
    applicationUrl: null,
    officialInformationUrl: null,
    appDownloadUrl: null,
    applicationMethod: null,
    eligibilityConditions: null,
    pickupMethod: null,
    paymentMethod: null,
    price: null,
    notes: null,
    ...overrides,
  };
}

function ingest(body: unknown) {
  return app.request("/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

function withAnalysisPayload(externalPostId: string, productNameRaw: string, contentHash = `hash-${externalPostId}`) {
  return {
    sourcePost: {
      externalPostId,
      authorUsername: "zabi_poc",
      sourceUrl: `https://x.com/zabi_poc/status/${externalPostId}`,
      bodyRaw: `${productNameRaw}の抽選開始されました`,
      publishedAt: "2026-07-01T00:00:00.000Z",
      contentHash,
      fetchedAt: new Date().toISOString(),
    },
    analysis: {
      postType: "lottery_started",
      isLotteryInformation: true,
      cardType: "pokemon",
      confidenceScore: 0.9,
      analysisStatus: "success",
      parserVersion: "test",
      inputContentHash: contentHash,
      extractedLotteries: [baseExtractedLottery({ productNameRaw, storeNameRaw: "テスト店舗" })],
      urls: [],
      errorMessage: null,
    },
  };
}

function lookup(authorUsername: string) {
  return app.request(`/internal/source-posts/known-external-ids?authorUsername=${authorUsername}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

function archive(id: number) {
  return app.request(`/internal/source-posts/${id}/archive`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

function unarchive(id: number) {
  return app.request(`/internal/source-posts/${id}/unarchive`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

function reanalyze(id: number) {
  return app.request(`/internal/source-posts/${id}/reanalyze`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

beforeAll(async () => {
  const db = createDb({ TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL });
  await migrate(db, { migrationsFolder: "./migrations" });
  const mod = await import("../src/app.ts");
  app = mod.createApp(createDb);
});

afterAll(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB_FILE + ext);
    } catch {
      /* ignore */
    }
  }
});

describe("source_posts archive", () => {
  it("archiveすると known-external-ids には引き続き既知として含まれる（再取得ループ防止）", async () => {
    const externalPostId = nextId();
    const res = await ingest(withAnalysisPayload(externalPostId, "アーカイブ対象カード"));
    const json: any = await res.json();
    expect(json.action).toBe("inserted");
    const sourcePostId = json.sourcePostId;

    const archiveRes = await archive(sourcePostId);
    expect(archiveRes.status).toBe(200);
    const archiveJson: any = await archiveRes.json();
    expect(archiveJson.archivedAt).not.toBeNull();

    const lookupRes = await lookup("zabi_poc");
    const lookupJson: any = await lookupRes.json();
    expect(lookupJson.externalPostIds).toContain(externalPostId);
  });

  it("archive済みsourcePostへ analysis付きingestしても lottery/candidateは作られない（skipped_archived）", async () => {
    const externalPostId = nextId();
    const first = await ingest(withAnalysisPayload(externalPostId, "スキップ確認カード"));
    const firstJson: any = await first.json();
    const sourcePostId = firstJson.sourcePostId;
    expect(firstJson.analysis.action).toBe("inserted");
    const firstLotteryCount = firstJson.analysis.lotteryCount;
    expect(firstLotteryCount).toBeGreaterThan(0);

    await archive(sourcePostId);

    // 本文を変えて再送（content変更 → 通常なら再解析されるはずのケース）
    const second = await ingest(
      withAnalysisPayload(externalPostId, "スキップ確認カード改", `hash-${externalPostId}-v2`)
    );
    const secondJson: any = await second.json();
    expect(secondJson.action).toBe("updated"); // sourcePost自体は通常どおり更新される
    expect(secondJson.analysis.action).toBe("skipped_archived");
    expect(secondJson.analysis.lotteryCount).toBe(0);
  });

  it("archive済みsourcePostのreanalyzeは409", async () => {
    const externalPostId = nextId();
    const res = await ingest(withAnalysisPayload(externalPostId, "再解析拒否確認カード"));
    const json: any = await res.json();
    await archive(json.sourcePostId);

    const reanalyzeRes = await reanalyze(json.sourcePostId);
    expect(reanalyzeRes.status).toBe(409);
  });

  it("unarchiveすると再度通常どおりanalysisが永続化される", async () => {
    const externalPostId = nextId();
    const first = await ingest(withAnalysisPayload(externalPostId, "アンアーカイブ確認カード"));
    const firstJson: any = await first.json();
    const sourcePostId = firstJson.sourcePostId;

    await archive(sourcePostId);
    const archivedRetry = await ingest(
      withAnalysisPayload(externalPostId, "アンアーカイブ確認カード改", `hash-${externalPostId}-v2`)
    );
    const archivedRetryJson: any = await archivedRetry.json();
    expect(archivedRetryJson.analysis.action).toBe("skipped_archived");

    const unarchiveRes = await unarchive(sourcePostId);
    expect(unarchiveRes.status).toBe(200);
    const unarchiveJson: any = await unarchiveRes.json();
    expect(unarchiveJson.archivedAt).toBeNull();

    const afterUnarchive = await ingest(
      withAnalysisPayload(externalPostId, "アンアーカイブ確認カード再改", `hash-${externalPostId}-v3`)
    );
    const afterUnarchiveJson: any = await afterUnarchive.json();
    expect(afterUnarchiveJson.analysis.action).toBe("inserted");
    expect(afterUnarchiveJson.analysis.lotteryCount).toBeGreaterThan(0);
  });

  it("存在しないIDのarchive/unarchive/reanalyzeは404", async () => {
    expect((await archive(999999)).status).toBe(404);
    expect((await unarchive(999999)).status).toBe(404);
    expect((await reanalyze(999999)).status).toBe(404);
  });

  it("Bearerなしは401", async () => {
    const res = await app.request("/internal/source-posts/1/archive", { method: "POST" });
    expect(res.status).toBe(401);
  });
});
