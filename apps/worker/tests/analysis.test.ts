import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { AnalysisInput } from "@x-post/shared";
import { createDb } from "../src/db/client.node.ts";
import { lotteries, postAnalyses, type PostAnalysisRow } from "../src/db/schema.ts";
import { decideAnalysisAction } from "../src/repositories/analysisRepository.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-analysis-${Date.now()}.db`);
const TOKEN = "test-token";
process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.INGEST_TOKEN = TOKEN;

let app: ReturnType<typeof import("../src/app.ts")["createApp"]>;
const db = createDb({ TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL });

const sourcePost = () => ({
  externalPostId: "555",
  sourceUrl: "https://x.com/zabi_poc/status/555",
  bodyRaw: "ドラゴンスターで「世界最強の戦士」の抽選開始されました",
  publishedAt: "2026-07-24T04:00:00.000Z",
  contentHash: "hash-post-555",
  fetchedAt: new Date().toISOString(),
});

const analysis = () => ({
  postType: "lottery_started",
  isLotteryInformation: true,
  cardType: "pokemon",
  confidenceScore: 0.8,
  analysisStatus: "success",
  parserVersion: "phase2-rules-1",
  inputContentHash: "hash-analysis-555",
  urls: [{ originalUrl: "https://t.co/abc", domain: "apps.apple.com", urlType: "app_download" }],
  extractedLotteries: [
    {
      cardType: "pokemon",
      productNameRaw: "世界最強の戦士",
      storeNameRaw: "ドラゴンスター",
      applicationEnd: { at: "2026-08-11T23:59:00+09:00", date: "2026-08-11", precision: "datetime", status: "extracted" },
    },
  ],
});

const post = (body: unknown, token = TOKEN) =>
  app.request("/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  app = (await import("../src/app.ts")).createApp(createDb);
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

describe("POST /ingest with analysis", () => {
  it("sourcePost + analysis → 抽選が inserted され正規化列も入る", async () => {
    const res = await post({ sourcePost: sourcePost(), analysis: analysis() });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.analysis.action).toBe("inserted");
    expect(json.analysis.lotteryCount).toBe(1);

    const rows = await db.select().from(lotteries).where(eq(lotteries.sourcePostId, json.sourcePostId));
    expect(rows.length).toBe(1);
    expect(rows[0].productNameRaw).toBe("世界最強の戦士");
    expect(rows[0].normalizedProductName).toBe("世界最強の戦士"); // 正規化(Worker)済み
    expect(rows[0].normalizerVersion).toBeTruthy();
    expect(rows[0].applicationEndAt).toBe("2026-08-11T23:59:00+09:00");
    expect(rows[0].applicationEndPrecision).toBe("datetime");

    const pa = await db.select().from(postAnalyses).where(eq(postAnalyses.sourcePostId, json.sourcePostId));
    expect(pa.length).toBe(1);
    expect(pa[0].parserVersion).toBe("phase2-rules-1");
    expect(pa[0].inputContentHash).toBe("hash-analysis-555");
  });

  it("同一 (hash/parser/prompt/model) の再送は reused（再解析しない）", async () => {
    const res = await post({ sourcePost: sourcePost(), analysis: analysis() });
    const json: any = await res.json();
    expect(json.analysis.action).toBe("reused");
    // 二重登録されない
    const pa = await db.select().from(postAnalyses).where(eq(postAnalyses.sourcePostId, json.sourcePostId));
    expect(pa.length).toBe(1);
  });

  it("analysis を付けない sourcePost のみでも成功（analysis なし）", async () => {
    const res = await post({ sourcePost: { ...sourcePost(), externalPostId: "556", sourceUrl: "https://x.com/z/status/556" } });
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(json.analysis).toBeUndefined();
  });
});

describe("contentHash による再解析判定 / needs_review", () => {
  const sp = (contentHash: string) => ({
    externalPostId: "557",
    sourceUrl: "https://x.com/zabi_poc/status/557",
    bodyRaw: "複数店舗の複雑投稿（要確認）",
    publishedAt: "2026-07-24T04:00:00.000Z",
    contentHash,
    fetchedAt: new Date().toISOString(),
  });
  const needsReview = (inputContentHash: string) => ({
    postType: "lottery_summary",
    isLotteryInformation: true,
    cardType: "pokemon",
    confidenceScore: 0.4,
    analysisStatus: "needs_review",
    parserVersion: "phase2-rules-1",
    inputContentHash,
    urls: [],
    extractedLotteries: [],
  });

  it("初回 needs_review は inserted、同一 contentHash 再送は reused（行が増えない）", async () => {
    const first: any = await (await post({ sourcePost: sp("hash-557a"), analysis: needsReview("hash-557a") })).json();
    expect(first.analysis.action).toBe("inserted");

    const second: any = await (await post({ sourcePost: sp("hash-557a"), analysis: needsReview("hash-557a") })).json();
    expect(second.analysis.action).toBe("reused");

    const pa = await db.select().from(postAnalyses).where(eq(postAnalyses.sourcePostId, second.sourcePostId));
    expect(pa.length).toBe(1); // 二重登録されない
  });

  it("contentHash が変われば再解析（inserted、行が増える）", async () => {
    const res: any = await (await post({ sourcePost: sp("hash-557b"), analysis: needsReview("hash-557b") })).json();
    expect(res.analysis.action).toBe("inserted");
    const pa = await db.select().from(postAnalyses).where(eq(postAnalyses.sourcePostId, res.sourcePostId));
    expect(pa.length).toBe(2); // 557a と 557b の2件
  });
});

// 再解析判定は inputContentHash × parserVersion の2キーで行う（parserVersion 変化＝解析ロジック改善）
describe("decideAnalysisAction（inputContentHash × parserVersion）", () => {
  const prior = (inputContentHash: string, parserVersion: string): PostAnalysisRow =>
    ({ inputContentHash, parserVersion, analysisStatus: "success" } as PostAnalysisRow);
  const incoming = (inputContentHash: string, parserVersion: string): AnalysisInput =>
    ({
      postType: "lottery_started",
      isLotteryInformation: true,
      cardType: "pokemon",
      confidenceScore: 0.8,
      analysisStatus: "success",
      parserVersion,
      inputContentHash,
      extractedLotteries: [],
      urls: [],
      errorMessage: null,
    } as AnalysisInput);

  it("contentHash 同じ / parserVersion 同じ → reused", () => {
    expect(decideAnalysisAction([prior("h1", "v1")], incoming("h1", "v1"))).toBe("reused");
  });

  it("contentHash 同じ / parserVersion 違う → inserted（ロジック改善で再解析）", () => {
    expect(decideAnalysisAction([prior("h1", "v1")], incoming("h1", "v2"))).toBe("inserted");
  });

  it("contentHash 違う / parserVersion 同じ → inserted", () => {
    expect(decideAnalysisAction([prior("h1", "v1")], incoming("h2", "v1"))).toBe("inserted");
  });

  it("contentHash 違う / parserVersion 違う → inserted", () => {
    expect(decideAnalysisAction([prior("h1", "v1")], incoming("h2", "v2"))).toBe("inserted");
  });

  it("prior なし → inserted", () => {
    expect(decideAnalysisAction([], incoming("h1", "v1"))).toBe("inserted");
  });
});
