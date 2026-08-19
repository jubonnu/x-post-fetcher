import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";

/**
 * test.md追加指示: summary投稿の各抽選は
 *   1. 既存と明確に同一 → 完全スキップ（update_candidateを作らない）
 *   2. 曖昧一致 → update_candidate / needs_review
 *   3. 有力な既存候補なし → 新規lottery候補
 * になっているかの検証（ユーザー指定シナリオ: 10件中 明確一致8・曖昧1・未登録1）。
 */

const DB_FILE = resolve(process.cwd(), `.tmp-test-${Date.now()}-summaryskip.db`);
const TOKEN = "test-token";

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.INGEST_TOKEN = TOKEN;

let app: ReturnType<typeof import("../src/app.ts")["createApp"]>;
let seq = 0;

function nextId(): string {
  seq += 1;
  return String(6000000 + seq);
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

/** 「新規抽選」として既存lotteryを1件作る（締切日も設定し、まとめ投稿側の締切一致でスコアを上げる）。 */
async function seedLottery(productNameRaw: string, storeNameRaw: string, applicationEndDate: string) {
  const externalPostId = nextId();
  const res = await ingest({
    sourcePost: {
      externalPostId,
      authorUsername: "zabi_poc",
      sourceUrl: `https://x.com/zabi_poc/status/${externalPostId}`,
      bodyRaw: `${storeNameRaw}で「${productNameRaw}」の抽選開始されました`,
      publishedAt: "2026-08-01T00:00:00.000Z",
      contentHash: `hash-${externalPostId}`,
      fetchedAt: new Date().toISOString(),
    },
    analysis: {
      postType: "lottery_started",
      isLotteryInformation: true,
      cardType: "pokemon",
      confidenceScore: 0.9,
      analysisStatus: "success",
      parserVersion: "test",
      inputContentHash: `hash-${externalPostId}`,
      extractedLotteries: [
        baseExtractedLottery({
          productNameRaw,
          storeNameRaw,
          applicationEnd: { date: applicationEndDate, precision: "date_only", status: "extracted" },
        }),
      ],
      urls: [],
      errorMessage: null,
    },
  });
  expect(res.status).toBe(200);
}

function summaryIngestPayload(externalPostId: string, extractedLotteries: unknown[]) {
  return {
    sourcePost: {
      externalPostId,
      authorUsername: "zabi_poc",
      sourceUrl: `https://x.com/zabi_poc/status/${externalPostId}`,
      bodyRaw: "抽選まとめ（テスト用10件）",
      publishedAt: "2026-08-10T00:00:00.000Z",
      contentHash: `hash-${externalPostId}`,
      fetchedAt: new Date().toISOString(),
    },
    analysis: {
      postType: "lottery_summary",
      isLotteryInformation: true,
      cardType: "pokemon",
      confidenceScore: 0.9,
      analysisStatus: "success",
      parserVersion: "test",
      inputContentHash: `hash-${externalPostId}`,
      extractedLotteries,
      urls: [],
      errorMessage: null,
    },
  };
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

describe("summary投稿: 明確一致はスキップ、曖昧一致のみcandidate、未登録は新規", () => {
  it("10件（明確一致8・曖昧一致1・未登録1）→ skip 8 / update_candidate 1 / new 1", async () => {
    // 明確一致用: 商品名・店舗名・締切日を完全一致させる（40+30+15=85 >= mergeThreshold(80)）
    const clearMatches: { product: string; store: string; date: string }[] = [];
    for (let i = 1; i <= 8; i++) {
      const product = `30th CELEBRATION ${i}`;
      const store = `店舗${i}`;
      const date = "2026-08-12";
      await seedLottery(product, store, date);
      clearMatches.push({ product, store, date });
    }

    // 曖昧一致用: 商品名・店舗名は一致させるが締切日は無し（40+30=70、50-79の範囲でreview扱い）
    await seedLottery("あいまい商品", "あいまい店舗", "2026-08-20");

    const summaryItems = [
      ...clearMatches.map((c) =>
        baseExtractedLottery({
          productNameRaw: c.product,
          storeNameRaw: c.store,
          applicationEnd: { date: c.date, precision: "date_only", status: "extracted" },
        })
      ),
      baseExtractedLottery({ productNameRaw: "あいまい商品", storeNameRaw: "あいまい店舗" }), // 締切なし→曖昧
      baseExtractedLottery({ productNameRaw: "誰も知らない新商品", storeNameRaw: "誰も知らない新店舗" }), // 未登録→新規
    ];
    expect(summaryItems).toHaveLength(10);

    const externalPostId = nextId();
    const res = await ingest(summaryIngestPayload(externalPostId, summaryItems));
    expect(res.status).toBe(200);
    const json: any = await res.json();
    const results = json.analysis.lotteryResults as { matchAction: string; matchScore: number }[];

    const skipCount = results.filter((r) => r.matchAction === "skipped_clear_match").length;
    const candidateCount = results.filter((r) => r.matchAction === "candidate").length;
    const newCount = results.filter((r) => r.matchAction === "new").length;

    expect(skipCount).toBe(8);
    expect(candidateCount).toBe(1);
    expect(newCount).toBe(1);
  });

  it("同じsummary投稿を再処理してもcandidateが増殖せず、lotteryも重複しない", async () => {
    await seedLottery("再処理テスト商品", "再処理テスト店舗", "2026-08-12");

    const externalPostId = nextId();
    const payload = summaryIngestPayload(externalPostId, [
      baseExtractedLottery({
        productNameRaw: "再処理テスト商品",
        storeNameRaw: "再処理テスト店舗",
        applicationEnd: { date: "2026-08-12", precision: "date_only", status: "extracted" },
      }),
      baseExtractedLottery({ productNameRaw: "再処理テスト新規商品", storeNameRaw: "再処理テスト新規店舗" }),
    ]);

    const res1 = await ingest(payload);
    const json1: any = await res1.json();
    expect(json1.analysis.action).toBe("inserted");
    const results1 = json1.analysis.lotteryResults as { matchAction: string; lotteryId: number | null }[];
    expect(results1.filter((r) => r.matchAction === "skipped_clear_match")).toHaveLength(1);
    expect(results1.filter((r) => r.matchAction === "new")).toHaveLength(1);
    const newLotteryId = results1.find((r) => r.matchAction === "new")!.lotteryId;

    // 同一内容（同一contentHash）を再送
    const res2 = await ingest(payload);
    const json2: any = await res2.json();
    expect(json2.analysis.action).toBe("reused"); // 再解析されないため、そもそも2回目のマッチングすら発生しない

    // 内容を変えて再解析をトリガーしても（別のcontentHash）、既に新規登録済みのlotteryは
    // own_updatedとして扱われ、二重にnewを作らない。
    const payload2 = {
      ...payload,
      sourcePost: { ...payload.sourcePost, contentHash: `${payload.sourcePost.contentHash}-v2` },
      analysis: { ...payload.analysis, inputContentHash: `${payload.analysis.inputContentHash}-v2` },
    };
    const res3 = await ingest(payload2);
    const json3: any = await res3.json();
    expect(json3.analysis.action).toBe("inserted"); // contentHashが変わったので再解析はされる
    const results3 = json3.analysis.lotteryResults as { matchAction: string; lotteryId: number | null }[];
    expect(results3.find((r) => r.matchAction === "own_updated")?.lotteryId).toBe(newLotteryId);
    expect(results3.filter((r) => r.matchAction === "new")).toHaveLength(0); // 新規は増えない
  });
});
