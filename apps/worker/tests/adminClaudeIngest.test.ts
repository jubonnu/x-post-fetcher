import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { lotteries, sourcePosts } from "../src/db/schema.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-admin-claude-ingest-${Date.now()}.db`);
const INGEST_TOKEN = "test-ingest-token";

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.INGEST_TOKEN = INGEST_TOKEN;
process.env.ADMIN_INVITE_CODE = "test-invite-code";
process.env.ADMIN_JWT_SECRET = "test-admin-jwt-secret-not-for-production";

let app: ReturnType<typeof import("../src/app.ts")["createApp"]>;
const db = createDb({ TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL });

let adminToken: string;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  const mod = await import("../src/app.ts");
  app = mod.createApp(createDb);

  const res = await app.request("/admin/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "claude-ingest-admin@example.com", password: "password123", inviteCode: "test-invite-code" }),
  });
  const body = (await res.json()) as { token: string };
  adminToken = body.token;
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

function authHeaders() {
  return { Authorization: `Bearer ${adminToken}` };
}

function jsonAuthHeaders() {
  return { "Content-Type": "application/json", ...authHeaders() };
}

function claudePost(overrides: Record<string, unknown> = {}) {
  return {
    externalPostId: `claude-${Date.now()}-${Math.random()}`,
    sourceUrl: "https://x.com/Zabi_pokeka/status/1",
    publishedAt: "2026-08-31T11:15:00+09:00",
    bodyRaw: "ゲオで「30th CELEBRATION/プレミアムデッキセット」の抽選開始されました",
    postType: "lottery_started",
    isLotteryInformation: true,
    cardType: "pokemon",
    confidenceScore: 0.9,
    extractedLotteries: [
      {
        productNameRaw: "30th CELEBRATION/プレミアムデッキセット",
        storeNameRaw: "ゲオ",
        applicationEnd: "2026-09-03T17:59:00+09:00",
        applicationUrl: "https://geo-online.co.jp/news/779",
      },
    ],
    ...overrides,
  };
}

function unrelatedPost(overrides: Record<string, unknown> = {}) {
  return {
    externalPostId: `claude-unrelated-${Date.now()}-${Math.random()}`,
    sourceUrl: "https://x.com/Zabi_pokeka/status/2",
    publishedAt: "2026-08-30T21:54:00+09:00",
    bodyRaw: "お休みします",
    postType: "unrelated",
    isLotteryInformation: false,
    cardType: "unknown",
    confidenceScore: 0.95,
    extractedLotteries: [],
    ...overrides,
  };
}

describe("POST /admin/claude-ingest", () => {
  it("未認証は401", async () => {
    const res = await app.request("/admin/claude-ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posts: [claudePost()] }),
    });
    expect(res.status).toBe(401);
  });

  it("抽選あり1件+無関係1件を送信するとsourcePosts/lotteriesに正しく反映される", async () => {
    const lottery = claudePost();
    const unrelated = unrelatedPost();

    const res = await app.request("/admin/claude-ingest", {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ posts: [lottery, unrelated] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: any[] };
    expect(body.results).toHaveLength(2);
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].action).toBe("inserted");
    expect(body.results[1].ok).toBe(true);

    const [sourceRow] = await db.select().from(sourcePosts).where(eq(sourcePosts.externalPostId, lottery.externalPostId));
    expect(sourceRow).toBeDefined();
    expect(sourceRow.bodyRaw).toBe(lottery.bodyRaw);

    const lotteryRows = await db.select().from(lotteries).where(eq(lotteries.sourcePostId, sourceRow.id));
    expect(lotteryRows).toHaveLength(1);
    expect(lotteryRows[0].productNameRaw).toBe("30th CELEBRATION/プレミアムデッキセット");

    const [unrelatedRow] = await db.select().from(sourcePosts).where(eq(sourcePosts.externalPostId, unrelated.externalPostId));
    expect(unrelatedRow).toBeDefined();
    const unrelatedLotteryRows = await db.select().from(lotteries).where(eq(lotteries.sourcePostId, unrelatedRow.id));
    expect(unrelatedLotteryRows).toHaveLength(0);
  });

  it("同一内容を/ingest(nested形式)と/admin/claude-ingest(flat形式)それぞれに送ると、保存されるlottery行の内容が一致する", async () => {
    // 商品名・店舗名は同一性マッチング（matchExistingLottery）に引っかからないよう
    // それぞれ一意にする（本テストの目的はマッチング挙動ではなく、日付/URLの正規化結果が
    // nested形式(ResolvedDateオブジェクト直接指定)とflat形式(ISO文字列→変換)で一致することの確認）。
    const applicationEndAt = "2026-09-10T20:00:00+09:00";
    const applicationUrl = "https://example.com/apply-equivalence";

    // /ingest（nested形式、自動パイプラインが送るのと同じ形）
    const ingestRes = await app.request("/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${INGEST_TOKEN}` },
      body: JSON.stringify({
        sourcePost: {
          externalPostId: "equivalence-ingest",
          sourceUrl: "https://x.com/Zabi_pokeka/status/equivalence-ingest",
          bodyRaw: "同一性検証店舗Aで「同一性検証商品A」の抽選開始されました",
          contentHash: "equivalence-hash-ingest",
          fetchedAt: new Date().toISOString(),
        },
        analysis: {
          postType: "lottery_started",
          isLotteryInformation: true,
          cardType: "pokemon",
          confidenceScore: 0.9,
          parserVersion: "test-parser",
          inputContentHash: "equivalence-hash-ingest",
          extractedLotteries: [
            {
              productNameRaw: "同一性検証商品A",
              storeNameRaw: "同一性検証店舗A",
              applicationEnd: { at: applicationEndAt, date: "2026-09-10", precision: "datetime", status: "extracted", rawText: null, yearInferred: false },
              applicationUrl,
            },
          ],
        },
      }),
    });
    expect(ingestRes.status).toBe(200);
    const ingestBody = (await ingestRes.json()) as { sourcePostId: number };

    // /admin/claude-ingest（flat形式：applicationEndはISO文字列で渡す）
    const adminRes = await app.request("/admin/claude-ingest", {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        posts: [
          {
            externalPostId: "equivalence-admin",
            sourceUrl: "https://x.com/Zabi_pokeka/status/equivalence-admin",
            bodyRaw: "同一性検証店舗Bで「同一性検証商品B」の抽選開始されました",
            postType: "lottery_started",
            isLotteryInformation: true,
            cardType: "pokemon",
            confidenceScore: 0.9,
            extractedLotteries: [
              {
                productNameRaw: "同一性検証商品B",
                storeNameRaw: "同一性検証店舗B",
                applicationEnd: applicationEndAt,
                applicationUrl,
              },
            ],
          },
        ],
      }),
    });
    expect(adminRes.status).toBe(200);
    const adminBody = (await adminRes.json()) as { results: Array<{ ok: boolean; sourcePostId: number; analysis?: { action: string } }> };
    expect(adminBody.results[0].ok).toBe(true);
    expect(adminBody.results[0].analysis?.action).toBe("inserted");

    const [ingestLottery] = await db.select().from(lotteries).where(eq(lotteries.sourcePostId, ingestBody.sourcePostId));
    const [adminLottery] = await db.select().from(lotteries).where(eq(lotteries.sourcePostId, adminBody.results[0].sourcePostId));

    // nested形式(ResolvedDateオブジェクト直接指定)とflat形式(ISO文字列→transformClaudePostで変換)
    // それぞれの経路で、DBに保存される正規化後の値が完全に一致することを確認する。
    expect(adminLottery.applicationEndAt).toBe(ingestLottery.applicationEndAt);
    expect(adminLottery.applicationEndDate).toBe(ingestLottery.applicationEndDate);
    expect(adminLottery.applicationEndPrecision).toBe(ingestLottery.applicationEndPrecision);
    expect(adminLottery.applicationUrl).toBe(ingestLottery.applicationUrl);
    expect(adminLottery.verificationStatus).toBe(ingestLottery.verificationStatus);
    expect(adminLottery.completenessScore).toBe(ingestLottery.completenessScore);
  });

  it("配列内の1件が不正でも他の件は正常に保存される", async () => {
    const good = claudePost();
    const bad = { externalPostId: "bad-post", sourceUrl: "not-a-url", postType: "lottery_started", isLotteryInformation: true, cardType: "pokemon", confidenceScore: 0.9 };

    const res = await app.request("/admin/claude-ingest", {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ posts: [good, bad] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: any[] };
    expect(body.results[0].ok).toBe(true);
    expect(body.results[1].ok).toBe(false);
    expect(body.results[1].kind).toBe("validation_failed");

    const [goodRow] = await db.select().from(sourcePosts).where(eq(sourcePosts.externalPostId, good.externalPostId));
    expect(goodRow).toBeDefined();
    const [badRow] = await db.select().from(sourcePosts).where(eq(sourcePosts.externalPostId, "bad-post"));
    expect(badRow).toBeUndefined();
  });

  it("解釈不能な日付文字列を含む投稿はZod検証で弾かれ、lotteriesに一切書き込まれない", async () => {
    const invalid = claudePost({
      externalPostId: "invalid-date-post",
      extractedLotteries: [{ productNameRaw: "壊れた日付商品", applicationEnd: "9月頃" }],
    });

    const res = await app.request("/admin/claude-ingest", {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ posts: [invalid] }),
    });
    const body = (await res.json()) as { results: any[] };
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].kind).toBe("validation_failed");

    const rows = await db.select().from(sourcePosts).where(eq(sourcePosts.externalPostId, "invalid-date-post"));
    expect(rows).toHaveLength(0);
  });

  it("重複投入(同一bodyRaw)は2回目がunchanged扱いになる", async () => {
    const post = claudePost({ externalPostId: "dup-post" });

    const first = await app.request("/admin/claude-ingest", {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ posts: [post] }),
    });
    const firstBody = (await first.json()) as { results: any[] };
    expect(firstBody.results[0].action).toBe("inserted");
    expect(firstBody.results[0].analysis.action).toBe("inserted");

    const second = await app.request("/admin/claude-ingest", {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ posts: [post] }),
    });
    const secondBody = (await second.json()) as { results: any[] };
    expect(secondBody.results[0].action).toBe("unchanged");
    expect(secondBody.results[0].analysis.action).toBe("reused");
  });
});

describe("Claude確認チェックポイント", () => {
  const authorUsername = `checkpoint-test-${Date.now()}`;

  it("未設定時は全フィールドnullで返る", async () => {
    const res = await app.request(`/admin/claude-ingest/checkpoint?authorUsername=${authorUsername}`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.externalPostId).toBeNull();
    expect(body.publishedAt).toBeNull();
    expect(body.checkedAt).toBeNull();
  });

  it("設定→取得で値が一致し、checkedAtが自動セットされる", async () => {
    const putRes = await app.request("/admin/claude-ingest/checkpoint", {
      method: "PUT",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ authorUsername, externalPostId: "999", publishedAt: "2026-08-31T11:15:00+09:00" }),
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as any;
    expect(putBody.externalPostId).toBe("999");
    expect(putBody.publishedAt).toBe("2026-08-31T11:15:00+09:00");
    expect(putBody.checkedAt).not.toBeNull();

    const getRes = await app.request(`/admin/claude-ingest/checkpoint?authorUsername=${authorUsername}`, {
      headers: authHeaders(),
    });
    const getBody = (await getRes.json()) as any;
    expect(getBody.externalPostId).toBe("999");
    expect(getBody.publishedAt).toBe("2026-08-31T11:15:00+09:00");
  });

  it("未認証は401", async () => {
    const res = await app.request(`/admin/claude-ingest/checkpoint?authorUsername=${authorUsername}`);
    expect(res.status).toBe(401);
  });
});
