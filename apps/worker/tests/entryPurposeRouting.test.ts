import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { lotteries } from "../src/db/schema.ts";

/**
 * test.md（キーワード分類機能）のシナリオ7・8・9・11の統合テスト。
 * scraper側（entryPurpose判定・analysisStatus調整）はscraperのユニットテストで検証済みのため、
 * ここではWorker側の既存マッチング/永続化ロジック（matchExistingLottery・
 * syncLotteriesFromAnalysis・persistAnalysisのneeds_review降格）が、scraperが送ってくる
 * ペイロードに対して期待どおりに振る舞うことをend-to-endで確認する。
 */

const DB_FILE = resolve(process.cwd(), `.tmp-test-${Date.now()}-entrypurpose.db`);
const TOKEN = "test-token";

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.INGEST_TOKEN = TOKEN;

let app: ReturnType<typeof import("../src/app.ts")["createApp"]>;
let db: ReturnType<typeof createDb>;
let seq = 0;

function nextId(): string {
  seq += 1;
  return String(5000000 + seq);
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

/** 「新規抽選」として既存lotteryを1件作る（matchExistingLotteryの比較対象を用意するため）。 */
async function seedLottery(productNameRaw: string, storeNameRaw: string, extra: Record<string, unknown> = {}) {
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
      extractedLotteries: [baseExtractedLottery({ productNameRaw, storeNameRaw, ...extra })],
      urls: [],
      errorMessage: null,
    },
  });
  expect(res.status).toBe(200);
  const json: any = await res.json();
  return json.analysis.lotteryResults[0].lotteryId as number;
}

beforeAll(async () => {
  db = createDb({ TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL });
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

describe("シナリオ7: summary内に既存3件+未取得1件", () => {
  it("既存3件はcandidate（自動更新なし）、未取得1件のみ新規lotteryになる", async () => {
    await seedLottery("30th CELEBRATION", "ヤマシロヤ");
    await seedLottery("30th CELEBRATION", "ホビーステーション");
    await seedLottery("30th CELEBRATION", "ふるいち");

    const externalPostId = nextId();
    const res = await ingest({
      sourcePost: {
        externalPostId,
        authorUsername: "zabi_poc",
        sourceUrl: `https://x.com/zabi_poc/status/${externalPostId}`,
        bodyRaw: "抽選まとめ：ヤマシロヤ/ホビーステーション/ふるいち/新店舗",
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
        extractedLotteries: [
          baseExtractedLottery({ productNameRaw: "30th CELEBRATION", storeNameRaw: "ヤマシロヤ" }),
          baseExtractedLottery({ productNameRaw: "30th CELEBRATION", storeNameRaw: "ホビーステーション" }),
          baseExtractedLottery({ productNameRaw: "30th CELEBRATION", storeNameRaw: "ふるいち" }),
          baseExtractedLottery({ productNameRaw: "30th CELEBRATION", storeNameRaw: "未取得の新店舗" }),
        ],
        urls: [],
        errorMessage: null,
      },
    });

    expect(res.status).toBe(200);
    const json: any = await res.json();
    const results = json.analysis.lotteryResults as { matchAction: string }[];
    expect(results.filter((r) => r.matchAction === "candidate")).toHaveLength(3);
    expect(results.filter((r) => r.matchAction === "new")).toHaveLength(1);
  });
});

describe("シナリオ8・9: result投稿", () => {
  it("8. 既存lottery候補がある場合はupdate_candidateになり、既存lotteryは自動更新されない", async () => {
    const lotteryId = await seedLottery("世界最強の戦士", "ドラゴンスター");

    const externalPostId = nextId();
    const res = await ingest({
      sourcePost: {
        externalPostId,
        authorUsername: "zabi_poc",
        sourceUrl: `https://x.com/zabi_poc/status/${externalPostId}`,
        bodyRaw: "世界最強の戦士 抽選結果発表",
        publishedAt: "2026-08-15T00:00:00.000Z",
        contentHash: `hash-${externalPostId}`,
        fetchedAt: new Date().toISOString(),
      },
      analysis: {
        postType: "result_announced",
        isLotteryInformation: true,
        cardType: "pokemon",
        confidenceScore: 0.9,
        analysisStatus: "needs_review", // scraper側がresult投稿に強制するステータス
        parserVersion: "test",
        inputContentHash: `hash-${externalPostId}`,
        extractedLotteries: [
          baseExtractedLottery({
            productNameRaw: "世界最強の戦士",
            storeNameRaw: "ドラゴンスター",
            resultAnnouncement: { at: "2026-08-16T00:00:00.000Z" },
          }),
        ],
        urls: [],
        errorMessage: null,
      },
    });

    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.analysis.lotteryResults[0].matchAction).toBe("candidate");

    // 既存lotteryのresultAnnouncementAtは自動更新されていない
    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, lotteryId));
    expect(row.resultAnnouncementAt).toBeNull();
  });

  it("9. 既存候補が見つからない場合、新規lotteryとして即座にextracted扱いにせずneeds_reviewにする", async () => {
    const externalPostId = nextId();
    const res = await ingest({
      sourcePost: {
        externalPostId,
        authorUsername: "zabi_poc",
        sourceUrl: `https://x.com/zabi_poc/status/${externalPostId}`,
        bodyRaw: "誰も知らない抽選 抽選結果発表",
        publishedAt: "2026-08-15T00:00:00.000Z",
        contentHash: `hash-${externalPostId}`,
        fetchedAt: new Date().toISOString(),
      },
      analysis: {
        postType: "result_announced",
        isLotteryInformation: true,
        cardType: "pokemon",
        confidenceScore: 0.9,
        analysisStatus: "needs_review",
        parserVersion: "test",
        inputContentHash: `hash-${externalPostId}`,
        extractedLotteries: [
          baseExtractedLottery({
            productNameRaw: "誰も知らない抽選商品XYZ",
            storeNameRaw: "誰も知らない店舗XYZ",
            resultAnnouncement: { at: "2026-08-16T00:00:00.000Z" },
          }),
        ],
        urls: [],
        errorMessage: null,
      },
    });

    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.analysis.lotteryResults[0].matchAction).toBe("new");
    const lotteryId = json.analysis.lotteryResults[0].lotteryId as number;

    const [row] = await db.select().from(lotteries).where(eq(lotteries.id, lotteryId));
    expect(row.verificationStatus).toBe("needs_review"); // "extracted"（即公開相当）にはしない
  });
});

describe("シナリオ11: 同じ投稿の再処理", () => {
  it("同一externalPostId・同一contentHashを2回送っても重複登録されない", async () => {
    const externalPostId = nextId();
    const payload = {
      sourcePost: {
        externalPostId,
        authorUsername: "zabi_poc",
        sourceUrl: `https://x.com/zabi_poc/status/${externalPostId}`,
        bodyRaw: "再送テスト用の抽選結果発表投稿",
        publishedAt: "2026-08-15T00:00:00.000Z",
        contentHash: `hash-${externalPostId}`,
        fetchedAt: new Date().toISOString(),
      },
      analysis: {
        postType: "result_announced",
        isLotteryInformation: true,
        cardType: "pokemon",
        confidenceScore: 0.9,
        analysisStatus: "needs_review",
        parserVersion: "test",
        inputContentHash: `hash-${externalPostId}`,
        extractedLotteries: [baseExtractedLottery({ productNameRaw: "再送テスト商品", storeNameRaw: "再送テスト店舗" })],
        urls: [],
        errorMessage: null,
      },
    };

    const res1 = await ingest(payload);
    const json1: any = await res1.json();
    expect(json1.analysis.action).toBe("inserted");

    const res2 = await ingest(payload);
    const json2: any = await res2.json();
    expect(json2.analysis.action).toBe("reused");

    const rows = await db.select().from(lotteries).where(eq(lotteries.sourcePostId, json1.sourcePostId));
    expect(rows).toHaveLength(1); // 重複登録なし
  });
});
