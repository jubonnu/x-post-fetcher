/**
 * 公開 GET /lotteries, GET /lotteries/:id テスト（Phase 5）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { lotteries } from "../src/db/schema.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-lotteries-${Date.now()}.db`);
const TOKEN = "test-token";

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.INGEST_TOKEN = TOKEN;

let app: ReturnType<typeof createApp>;

const get = (path: string) => app.request(path, { method: "GET" });
const authGet = (path: string) =>
  app.request(path, { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } });

beforeAll(async () => {
  const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });
  await migrate(db, { migrationsFolder: "./migrations" });

  // テスト用の抽選データを挿入
  await db.insert(lotteries).values([
    {
      productNameRaw: "MEGAドリームex",
      normalizedProductName: "MEGAドリームex",
      cardType: "pokemon",
      storeNameRaw: "ドラゴンスター",
      normalizedStoreName: "ドラゴンスター",
      verificationStatus: "extracted",
      status: "open",
    },
    {
      productNameRaw: "テラスタルフェス",
      normalizedProductName: "テラスタルフェス",
      cardType: "pokemon",
      storeNameRaw: "ホビーステーション",
      normalizedStoreName: "ホビーステーション",
      verificationStatus: "needs_review",
      status: "open",
    },
    {
      productNameRaw: "ONE PIECEブースター",
      normalizedProductName: "ONE PIECEブースター",
      cardType: "onepiece",
      storeNameRaw: "カードラッシュ",
      normalizedStoreName: "カードラッシュ",
      verificationStatus: "extracted",
      status: "open",
    },
  ]);

  app = createApp(createDb);
});

afterAll(() => {
  rmSync(DB_FILE);
});

describe("GET /lotteries", () => {
  it("認証不要で一覧を返す", async () => {
    const res = await get("/lotteries");
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(json.lotteries).toHaveLength(3);
    expect(json.total).toBe(3);
  });

  it("cardType フィルタ", async () => {
    const res = await get("/lotteries?cardType=pokemon");
    const json: any = await res.json();
    expect(json.lotteries).toHaveLength(2);
    expect(json.lotteries.every((l: any) => l.cardType === "pokemon")).toBe(true);
  });

  it("verificationStatus フィルタ", async () => {
    const res = await get("/lotteries?verificationStatus=needs_review");
    const json: any = await res.json();
    expect(json.lotteries).toHaveLength(1);
    expect(json.lotteries[0].normalizedProductName).toBe("テラスタルフェス");
  });

  it("limit / offset ページネーション", async () => {
    const res = await get("/lotteries?limit=2&offset=0");
    const json: any = await res.json();
    expect(json.lotteries).toHaveLength(2);
    expect(json.total).toBe(3);
    expect(json.limit).toBe(2);
    expect(json.offset).toBe(0);
  });

  it("limit は最大 100 に制限される", async () => {
    const res = await get("/lotteries?limit=999");
    const json: any = await res.json();
    expect(json.limit).toBe(100);
  });
});

describe("GET /lotteries/:id", () => {
  it("存在する ID は詳細を返す", async () => {
    // 最初の1件を取得して id を確認
    const listRes = await get("/lotteries?limit=1&offset=2"); // 3件目（offset=2）
    const { lotteries: list } = (await listRes.json()) as any;
    const id = list[0].id;

    const res = await get(`/lotteries/${id}`);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(json.lottery).toBeDefined();
    expect(json.sources).toBeDefined();
    expect(json.fieldHistory).toBeDefined();
  });

  it("存在しない ID は 404", async () => {
    const res = await get("/lotteries/99999");
    expect(res.status).toBe(404);
  });

  it("不正な ID は 400", async () => {
    const res = await get("/lotteries/abc");
    expect(res.status).toBe(400);
  });
});
