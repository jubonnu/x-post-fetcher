/**
 * 公開 GET /lotteries, GET /lotteries/:id テスト（Phase 5 + 一覧ソート/カーソルページネーション修正）。
 *
 * ソート順: 受付中 → 結果待ち → 終了済み → 日時未設定
 * - 受付中: 締切が近い順 / 結果待ち: 発表日が近い順 / 終了済み: 終了日時が新しい順
 * - 日付のみ（application_end_date等）の値はJSTの日付境界（翌日0時JSTでended）で解釈する
 *   （CardHubモバイル側 utils/time.ts の normalizeDeadline と同一ルール）。
 * - ページネーションはキーセット（cursor + asOf）方式。asOfはステータス分類の基準時刻を固定する。
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
const ASOF = "2026-08-03T00:00:00.000Z"; // JST 2026-08-03 09:00

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.INGEST_TOKEN = TOKEN;

let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof createDb>;

const ids: Record<string, number> = {};

const get = (path: string) => app.request(path, { method: "GET" });

function withAsOf(path: string, asOf: string = ASOF): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}asOf=${encodeURIComponent(asOf)}`;
}

beforeAll(async () => {
  db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });
  await migrate(db, { migrationsFolder: "./migrations" });

  const rows = await db
    .insert(lotteries)
    .values([
      {
        productNameRaw: "acceptingNear",
        normalizedProductName: "acceptingNear",
        cardType: "pokemon",
        storeNameRaw: "ドラゴンスター",
        verificationStatus: "extracted",
        status: "open",
        applicationEndAt: "2026-08-05T00:00:00.000Z",
      },
      {
        productNameRaw: "acceptingFar",
        normalizedProductName: "acceptingFar",
        cardType: "pokemon",
        storeNameRaw: "ドラゴンスター",
        verificationStatus: "extracted",
        status: "open",
        applicationEndAt: "2026-08-20T00:00:00.000Z",
      },
      {
        productNameRaw: "resultPending",
        normalizedProductName: "resultPending",
        cardType: "pokemon",
        storeNameRaw: "ホビーステーション",
        verificationStatus: "needs_review",
        status: "open",
        applicationEndAt: "2026-08-01T00:00:00.000Z",
        resultAnnouncementAt: "2026-08-10T00:00:00.000Z",
      },
      {
        productNameRaw: "endedNew",
        normalizedProductName: "endedNew",
        cardType: "onepiece",
        storeNameRaw: "カードラッシュ",
        verificationStatus: "extracted",
        status: "open",
        applicationEndAt: "2026-07-20T00:00:00.000Z",
        resultAnnouncementAt: "2026-07-25T00:00:00.000Z",
      },
      {
        productNameRaw: "endedOld",
        normalizedProductName: "endedOld",
        cardType: "onepiece",
        storeNameRaw: "カードラッシュ",
        verificationStatus: "extracted",
        status: "open",
        applicationEndAt: "2026-07-01T00:00:00.000Z",
        resultAnnouncementAt: "2026-07-05T00:00:00.000Z",
      },
      {
        productNameRaw: "unknown",
        normalizedProductName: "unknown",
        cardType: "onepiece",
        storeNameRaw: "カードラッシュ",
        verificationStatus: "extracted",
        status: "open",
      },
    ])
    .returning({ id: lotteries.id, productNameRaw: lotteries.productNameRaw });

  for (const r of rows) {
    ids[r.productNameRaw as string] = r.id;
  }

  app = createApp(createDb);
});

afterAll(() => {
  rmSync(DB_FILE);
});

describe("GET /lotteries", () => {
  it("認証不要で一覧を返す", async () => {
    const res = await get(withAsOf("/lotteries?limit=100"));
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(json.lotteries).toHaveLength(6);
    expect(json.total).toBe(6);
    expect(json.asOf).toBe(ASOF);
  });

  it("cardType フィルタ", async () => {
    const res = await get(withAsOf("/lotteries?cardType=pokemon&limit=100"));
    const json: any = await res.json();
    expect(json.lotteries).toHaveLength(3);
    expect(json.lotteries.every((l: any) => l.cardType === "pokemon")).toBe(true);
  });

  it("verificationStatus フィルタ", async () => {
    const res = await get(withAsOf("/lotteries?verificationStatus=needs_review&limit=100"));
    const json: any = await res.json();
    expect(json.lotteries).toHaveLength(1);
    expect(json.lotteries[0].normalizedProductName).toBe("resultPending");
  });

  it("limit は最大 100 に制限される", async () => {
    const res = await get(withAsOf("/lotteries?limit=999"));
    const json: any = await res.json();
    expect(json.limit).toBe(100);
  });

  it("並び順: 受付中(締切近い順) → 結果待ち(発表日近い順) → 終了済み(終了日時新しい順) → 日時未設定", async () => {
    const res = await get(withAsOf("/lotteries?limit=100"));
    const json: any = await res.json();
    const order = json.lotteries.map((l: any) => l.normalizedProductName);
    expect(order).toEqual(["acceptingNear", "acceptingFar", "resultPending", "endedNew", "endedOld", "unknown"]);
  });

  describe("日付のみ締切のJST境界（application_end_date）", () => {
    let boundaryId: number;

    beforeAll(async () => {
      const [row] = await db
        .insert(lotteries)
        .values({
          productNameRaw: "dateOnlyBoundary",
          normalizedProductName: "dateOnlyBoundary",
          cardType: "boundary",
          verificationStatus: "extracted",
          status: "open",
          applicationEndDate: "2026-08-03",
        })
        .returning({ id: lotteries.id });
      boundaryId = row.id;
    });

    it("JST 23:59:59時点（UTC0時=JST9時のasOf）ではまだ受付中扱い", async () => {
      const res = await get(withAsOf("/lotteries?limit=100", "2026-08-03T00:00:00.000Z"));
      const json: any = await res.json();
      const list = json.lotteries.map((l: any) => l.id);
      const boundaryIdx = list.indexOf(boundaryId);
      expect(boundaryIdx).toBeGreaterThanOrEqual(0);
      expect(boundaryIdx).toBeLessThan(list.indexOf(ids.acceptingNear));
      expect(boundaryIdx).toBeLessThan(list.indexOf(ids.resultPending));
      expect(boundaryIdx).toBeLessThan(list.indexOf(ids.endedNew));
    });

    it("JST翌日0時（UTC15時のasOf）ちょうどでended扱いになる", async () => {
      const res = await get(withAsOf("/lotteries?limit=100", "2026-08-03T15:00:00.000Z"));
      const json: any = await res.json();
      const list = json.lotteries.map((l: any) => l.id);
      const boundaryIdx = list.indexOf(boundaryId);
      expect(boundaryIdx).toBeGreaterThan(list.indexOf(ids.resultPending));
      expect(boundaryIdx).toBeLessThan(list.indexOf(ids.endedNew));
      expect(boundaryIdx).toBeLessThan(list.indexOf(ids.endedOld));
    });
  });

  describe("カーソルページネーション", () => {
    it("ページをまたいでも重複・欠落が無く、一括取得と同じ順序になる", async () => {
      const fullRes = await get(withAsOf("/lotteries?limit=100"));
      const fullJson: any = await fullRes.json();
      const fullIds = fullJson.lotteries.map((l: any) => l.id);

      const collected: number[] = [];
      let cursor: string | null = null;
      let guard = 0;
      do {
        const qs = new URLSearchParams({ limit: "2", asOf: ASOF });
        if (cursor) qs.set("cursor", cursor);
        const res = await get(`/lotteries?${qs.toString()}`);
        expect(res.status).toBe(200);
        const json: any = await res.json();
        collected.push(...json.lotteries.map((l: any) => l.id));
        cursor = json.nextCursor;
        guard++;
      } while (cursor && guard < 20);

      expect(collected).toEqual(fullIds);
      expect(new Set(collected).size).toBe(collected.length);
    });

    it("最終ページの nextCursor は null", async () => {
      const res = await get(withAsOf("/lotteries?limit=100"));
      const json: any = await res.json();
      expect(json.nextCursor).toBeNull();
    });

    it("不正な形式のcursorは400", async () => {
      const res = await get(withAsOf("/lotteries?cursor=%20invalid!!not-base64url"));
      expect(res.status).toBe(400);
    });

    it("cursorがあるのにasOfが無い場合は400", async () => {
      const first = await get(withAsOf("/lotteries?limit=2"));
      const firstJson: any = await first.json();
      expect(firstJson.nextCursor).toBeTruthy();

      const res = await get(`/lotteries?cursor=${encodeURIComponent(firstJson.nextCursor)}`);
      expect(res.status).toBe(400);
    });

    it("cursor発行時と異なるasOfを渡すと400", async () => {
      const first = await get(withAsOf("/lotteries?limit=2"));
      const firstJson: any = await first.json();

      const res = await get(
        `/lotteries?cursor=${encodeURIComponent(firstJson.nextCursor)}&asOf=${encodeURIComponent("2026-08-04T00:00:00.000Z")}`
      );
      expect(res.status).toBe(400);
    });

    it("型が不正なcursor（改ざん・破損値）は400", async () => {
      const bogus = Buffer.from(
        JSON.stringify({ priority: "not-a-number", sortKey: 0, id: 1, asOf: ASOF }),
        "utf-8"
      )
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const res = await get(withAsOf(`/lotteries?cursor=${bogus}`));
      expect(res.status).toBe(400);
    });

    it("不正な形式のasOfは400", async () => {
      const res = await get("/lotteries?asOf=not-a-date");
      expect(res.status).toBe(400);
    });
  });
});

describe("GET /lotteries/:id", () => {
  it("存在する ID は詳細を返す", async () => {
    const res = await get(`/lotteries/${ids.acceptingNear}`);
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

  it("applicationUrlsはDB上のJSON文字列から配列へ変換されて返る", async () => {
    const [row] = await db
      .insert(lotteries)
      .values({
        productNameRaw: "複数URLテスト",
        normalizedProductName: "複数URLテスト",
        storeNameRaw: "テスト店舗",
        verificationStatus: "extracted",
        status: "open",
        applicationUrls: JSON.stringify(["https://example.com/a", "https://example.com/b"]),
      })
      .returning();

    const res = await get(`/lotteries/${row.id}`);
    const json: any = await res.json();
    expect(json.lottery.applicationUrls).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("applicationUrls未設定はnullで返る（文字列のままではない）", async () => {
    const res = await get(`/lotteries/${ids.acceptingNear}`);
    const json: any = await res.json();
    expect(json.lottery.applicationUrls).toBeNull();
  });
});
