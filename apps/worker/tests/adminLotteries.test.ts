/**
 * Phase 7: 管理画面（/admin/lotteries/*）の結合テスト。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { lotteries } from "../src/db/schema.ts";
import type { Env } from "../src/env.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-admin-lotteries-${Date.now()}.db`);

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

async function insertLottery(overrides: Partial<typeof lotteries.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(lotteries)
    .values({ productNameRaw: "テスト商品", normalizedProductName: "テスト商品", verificationStatus: "extracted", ...overrides })
    .returning();
  return row.id;
}

let adminToken: string;

beforeAll(async () => {
  const res = await app.request("/admin/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "crud-admin@example.com", password: "password123", inviteCode: "test-invite-code" }),
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

describe("GET /admin/lotteries", () => {
  it("認証無しは401", async () => {
    const res = await app.request("/admin/lotteries");
    expect(res.status).toBe(401);
  });

  it("verificationStatusで絞り込める（rejected済みも一覧に含まれる）", async () => {
    await insertLottery({ productNameRaw: "承認済み商品", verificationStatus: "approved" });
    await insertLottery({ productNameRaw: "却下済み商品", verificationStatus: "rejected" });

    const res = await app.request("/admin/lotteries?verificationStatus=rejected", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { productNameRaw: string }[]; total: number };
    expect(body.items.some((i) => i.productNameRaw === "却下済み商品")).toBe(true);
    expect(body.items.every((i) => i.productNameRaw !== "承認済み商品")).toBe(true);
  });

  it("excludeVerificationStatusesで指定した値以外（NULL含む）を取得できる（要確認タブ用）", async () => {
    await insertLottery({ productNameRaw: "要確認A", verificationStatus: "extracted" });
    await insertLottery({ productNameRaw: "要確認B（未設定）", verificationStatus: null });
    await insertLottery({ productNameRaw: "承認済みは除外対象", verificationStatus: "approved" });
    await insertLottery({ productNameRaw: "却下済みも除外対象", verificationStatus: "rejected" });

    const res = await app.request("/admin/lotteries?excludeVerificationStatuses=approved,rejected", {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { productNameRaw: string }[] };
    const titles = body.items.map((i) => i.productNameRaw);
    expect(titles).toContain("要確認A");
    expect(titles).toContain("要確認B（未設定）");
    expect(titles).not.toContain("承認済みは除外対象");
    expect(titles).not.toContain("却下済みも除外対象");
  });

  it("limit/offsetで正しくページングできる（100件を超えても後続ページが取得できる）", async () => {
    for (let i = 0; i < 105; i++) {
      await insertLottery({ productNameRaw: `ページング商品${i}`, verificationStatus: "extracted" });
    }

    const page1 = await app.request("/admin/lotteries?limit=100&offset=0&verificationStatus=extracted", {
      headers: authHeaders(),
    });
    const page1Body = (await page1.json()) as { items: unknown[]; total: number };
    expect(page1Body.items).toHaveLength(100);
    expect(page1Body.total).toBeGreaterThanOrEqual(105);

    const page2 = await app.request("/admin/lotteries?limit=100&offset=100&verificationStatus=extracted", {
      headers: authHeaders(),
    });
    const page2Body = (await page2.json()) as { items: unknown[] };
    expect(page2Body.items.length).toBeGreaterThanOrEqual(5);
  });
});

describe("POST /admin/lotteries/:id/approve, /reject", () => {
  it("承認するとverificationStatus=approved、approvedByに管理者メールが記録される", async () => {
    const id = await insertLottery();
    const res = await app.request(`/admin/lotteries/${id}/approve`, { method: "POST", headers: authHeaders() });
    expect(res.status).toBe(200);

    const detailRes = await app.request(`/admin/lotteries/${id}`, { headers: authHeaders() });
    const detail = (await detailRes.json()) as { lottery: { verificationStatus: string; approvedBy: string } };
    expect(detail.lottery.verificationStatus).toBe("approved");
    expect(detail.lottery.approvedBy).toBe("crud-admin@example.com");
  });

  it("却下するとverificationStatus=rejected、reasonが記録される", async () => {
    const id = await insertLottery();
    const res = await app.request(`/admin/lotteries/${id}/reject`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ reason: "情報が不正確なため" }),
    });
    expect(res.status).toBe(200);

    const detailRes = await app.request(`/admin/lotteries/${id}`, { headers: authHeaders() });
    const detail = (await detailRes.json()) as { lottery: { verificationStatus: string; rejectedReason: string } };
    expect(detail.lottery.verificationStatus).toBe("rejected");
    expect(detail.lottery.rejectedReason).toBe("情報が不正確なため");
  });

  it("存在しないidは404", async () => {
    const res = await app.request("/admin/lotteries/999999/approve", { method: "POST", headers: authHeaders() });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /admin/lotteries/:id", () => {
  it("タイトル・店舗・締切・応募方法・応募URLを更新できる", async () => {
    const id = await insertLottery({ applicationEndDate: "2026-08-06" });

    const res = await app.request(`/admin/lotteries/${id}`, {
      method: "PATCH",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        productNameRaw: "修正後のタイトル",
        storeNameRaw: "修正後の店舗",
        applicationEndAt: "2026-08-07T15:00:00.000Z",
        applicationMethod: "アプリから応募",
        applicationUrl: "https://example.com/apply",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lottery: {
        productNameRaw: string;
        storeNameRaw: string;
        applicationEndAt: string;
        applicationEndDate: string | null;
        applicationMethod: string;
        applicationUrl: string;
        resolvedApplicationUrl: string;
      };
    };
    expect(body.lottery.productNameRaw).toBe("修正後のタイトル");
    expect(body.lottery.storeNameRaw).toBe("修正後の店舗");
    expect(body.lottery.applicationEndAt).toBe("2026-08-07T15:00:00.000Z");
    // _atを管理者が設定したら、AI抽出由来の日付のみ値はクリアされる
    expect(body.lottery.applicationEndDate).toBeNull();
    expect(body.lottery.applicationMethod).toBe("アプリから応募");
    expect(body.lottery.applicationUrl).toBe("https://example.com/apply");
    // resolvedApplicationUrlが優先表示されるため、両方に反映されている必要がある
    expect(body.lottery.resolvedApplicationUrl).toBe("https://example.com/apply");
  });

  it("フィールドを未指定のままにすると既存値を保持する", async () => {
    const id = await insertLottery({ storeNameRaw: "元の店舗" });
    const res = await app.request(`/admin/lotteries/${id}`, {
      method: "PATCH",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ productNameRaw: "タイトルだけ変更" }),
    });
    const body = (await res.json()) as { lottery: { storeNameRaw: string } };
    expect(body.lottery.storeNameRaw).toBe("元の店舗");
  });

  it("空文字を送るとnull（クリア）として扱われる", async () => {
    const id = await insertLottery({ applicationMethod: "元の応募方法" });
    const res = await app.request(`/admin/lotteries/${id}`, {
      method: "PATCH",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ applicationMethod: "" }),
    });
    const body = (await res.json()) as { lottery: { applicationMethod: string | null } };
    expect(body.lottery.applicationMethod).toBeNull();
  });

  it("不正な日時形式は422 VALIDATION_ERROR", async () => {
    const id = await insertLottery();
    const res = await app.request(`/admin/lotteries/${id}`, {
      method: "PATCH",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ applicationEndAt: "not-a-date" }),
    });
    expect(res.status).toBe(422);
  });
});

function fakeBucket() {
  const store = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    async put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) {
      store.set(key, { body: new Uint8Array(value), contentType: options?.httpMetadata?.contentType ?? "" });
    },
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      return { body: entry.body, httpMetadata: { contentType: entry.contentType } };
    },
    async delete(key: string) {
      store.delete(key);
    },
    __store: store,
  } as unknown as Env["LOTTERY_IMAGES"] & { __store: Map<string, unknown> };
}

describe("POST /admin/lotteries/:id/image", () => {
  it("画像をアップロードするとimageUrlが保存され、/images/:keyで取得できる", async () => {
    const id = await insertLottery();
    const bucket = fakeBucket();
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const uploadRes = await app.request(
      `/admin/lotteries/${id}/image`,
      { method: "POST", headers: { "Content-Type": "image/png", ...authHeaders() }, body: bytes },
      { LOTTERY_IMAGES: bucket } as Partial<Env>
    );
    expect(uploadRes.status).toBe(200);
    const uploadBody = (await uploadRes.json()) as { imageUrl: string };
    expect(uploadBody.imageUrl).toMatch(new RegExp(`^http://[^/]+/images/${id}-\\d+\\.png$`));

    const imagePath = new URL(uploadBody.imageUrl).pathname;
    const imageRes = await app.request(imagePath, {}, { LOTTERY_IMAGES: bucket } as Partial<Env>);
    expect(imageRes.status).toBe(200);
    expect(imageRes.headers.get("Content-Type")).toBe("image/png");

    const detailRes = await app.request(`/admin/lotteries/${id}`, { headers: authHeaders() });
    const detail = (await detailRes.json()) as { lottery: { imageUrl: string } };
    expect(detail.lottery.imageUrl).toBe(uploadBody.imageUrl);
  });

  it("対応していない形式（例: image/gif）は422 VALIDATION_ERROR", async () => {
    const id = await insertLottery();
    const res = await app.request(
      `/admin/lotteries/${id}/image`,
      { method: "POST", headers: { "Content-Type": "image/gif", ...authHeaders() }, body: new Uint8Array([1]) },
      { LOTTERY_IMAGES: fakeBucket() } as Partial<Env>
    );
    expect(res.status).toBe(422);
  });

  it("バケット未設定なら500 CONFIG_ERROR", async () => {
    const id = await insertLottery();
    const res = await app.request(`/admin/lotteries/${id}/image`, {
      method: "POST",
      headers: { "Content-Type": "image/png", ...authHeaders() },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(500);
  });
});

describe("DELETE /admin/lotteries/:id/image", () => {
  it("画像を削除するとR2から消え、imageUrlがnullになる", async () => {
    const id = await insertLottery();
    const bucket = fakeBucket();

    const uploadRes = await app.request(
      `/admin/lotteries/${id}/image`,
      { method: "POST", headers: { "Content-Type": "image/png", ...authHeaders() }, body: new Uint8Array([1, 2, 3]) },
      { LOTTERY_IMAGES: bucket } as Partial<Env>
    );
    const uploadBody = (await uploadRes.json()) as { imageUrl: string };
    const key = new URL(uploadBody.imageUrl).pathname.replace(/^\/images\//, "");
    expect(bucket.__store.has(key)).toBe(true);

    const deleteRes = await app.request(
      `/admin/lotteries/${id}/image`,
      { method: "DELETE", headers: authHeaders() },
      { LOTTERY_IMAGES: bucket } as Partial<Env>
    );
    expect(deleteRes.status).toBe(200);
    expect(bucket.__store.has(key)).toBe(false);

    const detailRes = await app.request(`/admin/lotteries/${id}`, { headers: authHeaders() });
    const detail = (await detailRes.json()) as { lottery: { imageUrl: string | null } };
    expect(detail.lottery.imageUrl).toBeNull();
  });

  it("元々画像が無い場合も冪等に200", async () => {
    const id = await insertLottery();
    const res = await app.request(
      `/admin/lotteries/${id}/image`,
      { method: "DELETE", headers: authHeaders() },
      { LOTTERY_IMAGES: fakeBucket() } as Partial<Env>
    );
    expect(res.status).toBe(200);
  });

  it("存在しないidは404", async () => {
    const res = await app.request(
      `/admin/lotteries/999999/image`,
      { method: "DELETE", headers: authHeaders() },
      { LOTTERY_IMAGES: fakeBucket() } as Partial<Env>
    );
    expect(res.status).toBe(404);
  });

  it("画像がある状態でバケット未設定なら500 CONFIG_ERROR", async () => {
    const id = await insertLottery();
    const bucket = fakeBucket();
    await app.request(
      `/admin/lotteries/${id}/image`,
      { method: "POST", headers: { "Content-Type": "image/png", ...authHeaders() }, body: new Uint8Array([1]) },
      { LOTTERY_IMAGES: bucket } as Partial<Env>
    );

    const res = await app.request(`/admin/lotteries/${id}/image`, { method: "DELETE", headers: authHeaders() });
    expect(res.status).toBe(500);
  });
});

describe("GET /admin/lotteries?search=", () => {
  it("商品名・店舗名の部分一致で絞り込める", async () => {
    await insertLottery({ productNameRaw: "重複統合検索用のメガドリームex", storeNameRaw: "ドラゴンスター" });
    await insertLottery({ productNameRaw: "全然関係ない商品", storeNameRaw: "別の店舗" });

    const res = await app.request("/admin/lotteries?search=メガドリーム", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { productNameRaw: string }[]; total: number };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.every((i) => i.productNameRaw.includes("メガドリーム"))).toBe(true);
  });
});

describe("POST /admin/lotteries/:id/merge-into", () => {
  it("重複側の情報でtarget側の空欄を補完し、重複側はlifecycleStatus=mergedになる", async () => {
    const targetId = await insertLottery({
      productNameRaw: "メガドリームex",
      storeNameRaw: "ドラゴンスター",
      resultAnnouncementDate: null,
    });
    const duplicateId = await insertLottery({
      productNameRaw: "メガドリームex",
      storeNameRaw: "ドラゴンスター",
      resultAnnouncementDate: "2026-08-15",
      verificationStatus: "needs_review",
    });

    const res = await app.request(`/admin/lotteries/${duplicateId}/merge-into`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ targetId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; targetId: number; changedFields: string[] };
    expect(body.targetId).toBe(targetId);
    expect(body.changedFields).toContain("resultAnnouncementDate");

    const targetRes = await app.request(`/admin/lotteries/${targetId}`, { headers: authHeaders() });
    const targetDetail = (await targetRes.json()) as { lottery: { resultAnnouncementDate: string | null } };
    expect(targetDetail.lottery.resultAnnouncementDate).toBe("2026-08-15");

    const duplicateRes = await app.request(`/admin/lotteries/${duplicateId}`, { headers: authHeaders() });
    const duplicateDetail = (await duplicateRes.json()) as {
      lottery: { lifecycleStatus: string; mergedIntoLotteryId: number | null };
    };
    expect(duplicateDetail.lottery.lifecycleStatus).toBe("merged");
    expect(duplicateDetail.lottery.mergedIntoLotteryId).toBe(targetId);
  });

  it("統合後、重複側は公開一覧（管理一覧含む）から消える", async () => {
    const targetId = await insertLottery();
    const duplicateId = await insertLottery();

    await app.request(`/admin/lotteries/${duplicateId}/merge-into`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ targetId }),
    });

    const res = await app.request(`/admin/lotteries?search=テスト商品`, { headers: authHeaders() });
    const body = (await res.json()) as { items: { id: number }[] };
    expect(body.items.some((i) => i.id === duplicateId)).toBe(false);
  });

  it("存在しないidは404", async () => {
    const targetId = await insertLottery();
    const res = await app.request(`/admin/lotteries/999999/merge-into`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ targetId }),
    });
    expect(res.status).toBe(404);
  });

  it("存在しないtargetIdは404", async () => {
    const duplicateId = await insertLottery();
    const res = await app.request(`/admin/lotteries/${duplicateId}/merge-into`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ targetId: 999999 }),
    });
    expect(res.status).toBe(404);
  });

  it("自分自身への統合は422 VALIDATION_ERROR", async () => {
    const id = await insertLottery();
    const res = await app.request(`/admin/lotteries/${id}/merge-into`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ targetId: id }),
    });
    expect(res.status).toBe(422);
  });
});
