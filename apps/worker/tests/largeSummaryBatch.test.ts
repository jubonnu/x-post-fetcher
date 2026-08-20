import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "drizzle-orm/libsql/migrator";
import { makeDb, type CreateDb, type Db } from "../src/db/client.ts";
import { createDb } from "../src/db/client.node.ts";

/**
 * test.md追加指示（staging実データで発見した障害の再発防止）:
 * 1投稿から43件のlottery候補を含むsummary投稿を処理すると、syncLotteriesFromAnalysisが
 * 候補ごとに既存lottery全件を再取得していたためCloudflare Workersのsubrequest上限付近に
 * 到達し、処理が途中（14/43件）で失敗していた。かつ失敗前にpost_analyses行が
 * analysisStatus="success"で先にcommitされてしまうため、以後の再スクレイプが
 * reused判定してしまい残り29件が永久に取りこぼされる、という二重の障害だった。
 *
 * このテストは:
 *  - 43件全件が最後まで処理されること
 *  - analysisActionがfailedにならないこと
 *  - DBアクセス回数（lotteriesテーブルへのSELECT）が候補数に比例して増えないこと（1回のみ）
 *  - 同じ43件summaryを再処理しても重複しないこと（冪等性）
 * を検証する。
 */

const DB_FILE = resolve(process.cwd(), `.tmp-test-${Date.now()}-largesummary.db`);
const TOKEN = "test-token";

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.INGEST_TOKEN = TOKEN;

let app: ReturnType<typeof import("../src/app.ts")["createApp"]>;
let lotteriesSelectCalls: string[] = [];
let seq = 0;

function nextId(): string {
  seq += 1;
  return String(7000000 + seq);
}

/** lotteriesテーブルへのSELECT回数を計測するため、libsql Clientの execute/batch をラップしたcreateDb。 */
const instrumentedCreateDb: CreateDb = (env): Db => {
  const url = env.TURSO_DATABASE_URL ?? "file:local.db";
  const client = createClient({ url, authToken: env.TURSO_AUTH_TOKEN });

  function recordIfLotteriesSelect(sqlArg: unknown): void {
    const text = typeof sqlArg === "string" ? sqlArg : ((sqlArg as { sql?: string })?.sql ?? "");
    if (/^\s*select/i.test(text) && text.includes('"lotteries"')) {
      lotteriesSelectCalls.push(text);
    }
  }

  // persistAnalysisをトランザクションで包む修正（本チケットの対応2）により、実際のクエリは
  // client.transaction()が返すTransactionオブジェクト経由で発行される。トップレベルの
  // execute/batchだけでなく、transaction()の返り値もラップしないと計測が漏れる。
  function wrapExecuteBatch<T extends object>(target: T): T {
    return new Proxy(target, {
      get(t, prop, receiver) {
        const orig = Reflect.get(t, prop, receiver);
        if (prop === "execute" && typeof orig === "function") {
          return (...args: unknown[]) => {
            recordIfLotteriesSelect(args[0]);
            return (orig as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        if (prop === "batch" && typeof orig === "function") {
          return (...args: unknown[]) => {
            const stmts = args[0] as unknown[];
            if (Array.isArray(stmts)) for (const s of stmts) recordIfLotteriesSelect(s);
            return (orig as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        if (prop === "transaction" && typeof orig === "function") {
          return async (...args: unknown[]) => {
            const tx = await (orig as (...a: unknown[]) => unknown).apply(t, args);
            return wrapExecuteBatch(tx as object);
          };
        }
        return typeof orig === "function" ? (orig as (...a: unknown[]) => unknown).bind(t) : orig;
      },
    });
  }

  return makeDb(wrapExecuteBatch(client));
};

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

async function seedLottery(rawDb: ReturnType<typeof createDb>, productNameRaw: string, storeNameRaw: string, applicationEndDate: string) {
  const externalPostId = nextId();
  const app2 = (await import("../src/app.ts")).createApp(() => rawDb);
  const res = await app2.request("/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
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
    }),
  });
  expect(res.status).toBe(200);
}

function build43ItemSummary(externalPostId: string) {
  const items = [];
  // 5件: 明確一致（商品名・店舗名・締切日を完全一致させる → score 85 >= mergeThreshold）
  for (let i = 1; i <= 5; i++) {
    items.push(
      baseExtractedLottery({
        productNameRaw: `明確一致商品${i}`,
        storeNameRaw: `明確一致店舗${i}`,
        applicationEnd: { date: "2026-08-12", precision: "date_only", status: "extracted" },
      })
    );
  }
  // 3件: 曖昧一致（商品名・店舗名は一致するが締切日なし → score 70、review帯）
  for (let i = 1; i <= 3; i++) {
    items.push(baseExtractedLottery({ productNameRaw: `曖昧一致商品${i}`, storeNameRaw: `曖昧一致店舗${i}` }));
  }
  // 35件: 未登録（新規）。externalPostIdを商品名に含め、テスト間で商品名が衝突しないようにする
  // （衝突すると別テストで作られた"新規"lotteryにマッチしてcandidate扱いになってしまうため）。
  for (let i = 1; i <= 35; i++) {
    items.push(baseExtractedLottery({ productNameRaw: `新規商品${externalPostId}-${i}`, storeNameRaw: `新規店舗${externalPostId}-${i}` }));
  }
  expect(items).toHaveLength(43);

  return {
    sourcePost: {
      externalPostId,
      authorUsername: "zabi_poc",
      sourceUrl: `https://x.com/zabi_poc/status/${externalPostId}`,
      bodyRaw: "抽選まとめ（43件テスト）",
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
      extractedLotteries: items,
      urls: [],
      errorMessage: null,
    },
  };
}

let verifyDb: ReturnType<typeof createDb>;

beforeAll(async () => {
  verifyDb = createDb({ TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL });
  await migrate(verifyDb, { migrationsFolder: "./migrations" });

  for (let i = 1; i <= 5; i++) {
    await seedLottery(verifyDb, `明確一致商品${i}`, `明確一致店舗${i}`, "2026-08-12");
  }
  for (let i = 1; i <= 3; i++) {
    await seedLottery(verifyDb, `曖昧一致商品${i}`, `曖昧一致店舗${i}`, "2026-08-20");
  }

  const mod = await import("../src/app.ts");
  app = mod.createApp(instrumentedCreateDb);
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

describe("43件summary投稿の大規模バッチ処理", () => {
  it("43件全件が最後まで処理され、analysisActionはfailedにならない", async () => {
    lotteriesSelectCalls = [];
    const externalPostId = nextId();
    const res = await ingest(build43ItemSummary(externalPostId));
    expect(res.status).toBe(200);
    const json: any = await res.json();

    expect(json.analysis.action).toBe("inserted"); // "failed" にならない
    const results = json.analysis.lotteryResults as { matchAction: string }[];
    expect(results).toHaveLength(43); // 全43件が最後まで処理される

    const skip = results.filter((r) => r.matchAction === "skipped_clear_match").length;
    const candidate = results.filter((r) => r.matchAction === "candidate").length;
    const newCount = results.filter((r) => r.matchAction === "new").length;
    expect(skip).toBe(5);
    expect(candidate).toBe(3);
    expect(newCount).toBe(35);
  });

  it("lotteriesテーブルへのSELECTは候補数(43)に比例せず、定数回（own分+全体分の高々2回）で完了する", () => {
    // 修正前は「候補ごとに既存lottery全件を再取得」していたため43回以上発生していた。
    expect(lotteriesSelectCalls.length).toBeLessThanOrEqual(2);
    expect(lotteriesSelectCalls.length).toBeGreaterThan(0); // 呼ばれてはいる（0件は別の意味でおかしい）
  });

  it("analysisStatusが記録されたpost_analysesは常にsuccess（部分失敗の痕跡が残らない）", async () => {
    const { postAnalyses } = await import("../src/db/schema.ts");
    const { desc } = await import("drizzle-orm");
    const rows = await verifyDb.select().from(postAnalyses).orderBy(desc(postAnalyses.id)).limit(1);
    expect(rows[0].analysisStatus).toBe("success");
  });

  it("同じ43件summaryを再処理しても重複しない（skipped_clear_match/candidate/new件数が変わらない）", async () => {
    lotteriesSelectCalls = [];
    const externalPostId = nextId();
    const payload = build43ItemSummary(externalPostId);

    const res1 = await ingest(payload);
    const json1: any = await res1.json();
    expect(json1.analysis.action).toBe("inserted");

    const { lotteries, lotteryUpdateCandidates } = await import("../src/db/schema.ts");
    const { eq } = await import("drizzle-orm");
    const lotteriesAfter1 = await verifyDb.select().from(lotteries).where(eq(lotteries.sourcePostId, json1.sourcePostId));
    const candidatesAfter1 = await verifyDb
      .select()
      .from(lotteryUpdateCandidates)
      .where(eq(lotteryUpdateCandidates.sourcePostId, json1.sourcePostId));
    expect(lotteriesAfter1).toHaveLength(35); // 新規35件
    expect(candidatesAfter1).toHaveLength(3); // 曖昧一致3件

    // 内容を変えず同一payloadを再送 → contentHash一致でreused、DB増殖なし
    const res2 = await ingest(payload);
    const json2: any = await res2.json();
    expect(json2.analysis.action).toBe("reused");

    const lotteriesAfter2 = await verifyDb.select().from(lotteries).where(eq(lotteries.sourcePostId, json1.sourcePostId));
    const candidatesAfter2 = await verifyDb
      .select()
      .from(lotteryUpdateCandidates)
      .where(eq(lotteryUpdateCandidates.sourcePostId, json1.sourcePostId));
    expect(lotteriesAfter2).toHaveLength(35); // 増殖なし
    expect(candidatesAfter2).toHaveLength(3); // 増殖なし

    // parserVersionが変わり再解析がトリガーされても（内容は同一）、既存の own_updated 経路で
    // 二重にnew/candidateを作らないことを確認する。
    const payload2 = {
      ...payload,
      analysis: { ...payload.analysis, parserVersion: "test-v2", inputContentHash: `${payload.analysis.inputContentHash}-v2` },
    };
    const res3 = await ingest(payload2);
    const json3: any = await res3.json();
    expect(json3.analysis.action).toBe("inserted");
    const results3 = json3.analysis.lotteryResults as { matchAction: string }[];
    expect(results3.filter((r) => r.matchAction === "new")).toHaveLength(0); // own_updatedになるはずでnewは増えない
    expect(results3.filter((r) => r.matchAction === "own_updated")).toHaveLength(35);

    const lotteriesAfter3 = await verifyDb.select().from(lotteries).where(eq(lotteries.sourcePostId, json1.sourcePostId));
    expect(lotteriesAfter3).toHaveLength(35); // 依然として増殖なし
  });
});
