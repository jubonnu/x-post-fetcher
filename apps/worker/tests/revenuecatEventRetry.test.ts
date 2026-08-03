/**
 * Mobile-G4 Hardening（課金公開前Blocker）: failed_retryableなRevenueCatイベントの
 * 自動再処理（`retryFailedRevenuecatEventsBatch`）の単体テスト。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/db/client.node.ts";
import { revenuecatEvents, subscriptionEntitlements, userIdentities, users } from "../src/db/schema.ts";
import { retryFailedRevenuecatEventsBatch } from "../src/services/revenuecatEventRetryService.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-revenuecat-event-retry-${Date.now()}.db`);
const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });

const originalFetch = global.fetch;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
});

afterAll(() => {
  rmSync(DB_FILE);
});

beforeEach(async () => {
  // 各テストを完全に独立させるため、関連テーブルを空にしてから始める
  // （failed_retryableのまま残す挙動を検証するテストがあり、次のテストへ漏れると
  // scanned等の集計値が汚染されるため）。
  await db.delete(revenuecatEvents);
  await db.delete(subscriptionEntitlements);
  await db.delete(userIdentities);
  await db.delete(users);
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function insertUser(publicUserId: string): Promise<number> {
  const [user] = await db.insert(users).values({ publicUserId }).returning();
  return user.id;
}

async function insertFailedEvent(params: {
  revenueCatEventId: string;
  eventType?: string;
  appUserId: string;
  originalAppUserId?: string | null;
  aliasesJson?: string | null;
  eventTimestamp?: string;
  transferredFrom?: string[];
  transferredTo?: string[];
}) {
  const [row] = await db
    .insert(revenuecatEvents)
    .values({
      revenueCatEventId: params.revenueCatEventId,
      eventType: params.eventType ?? "INITIAL_PURCHASE",
      appUserId: params.appUserId,
      originalAppUserId: params.originalAppUserId ?? null,
      aliasesJson: params.aliasesJson ?? null,
      transferredFromJson: params.transferredFrom ? JSON.stringify(params.transferredFrom) : null,
      transferredToJson: params.transferredTo ? JSON.stringify(params.transferredTo) : null,
      environment: "SANDBOX",
      eventTimestamp: params.eventTimestamp ?? new Date().toISOString(),
      payloadHash: "test-hash",
      processingStatus: "failed_retryable",
    })
    .returning();
  return row;
}

function mockFetchWithSubscriber(byAppUserId: Record<string, { active: boolean } | "error">) {
  global.fetch = vi.fn().mockImplementation(async (url: string) => {
    const appUserId = decodeURIComponent(url.split("/subscribers/")[1]);
    const mock = byAppUserId[appUserId];
    if (!mock || mock === "error") {
      return new Response("", { status: 500 });
    }
    const entitlements = mock.active
      ? { premium: { product_identifier: "cardhub_premium_monthly", expires_date: new Date(Date.now() + 86_400_000).toISOString() } }
      : {};
    return new Response(JSON.stringify({ subscriber: { entitlements } }), { status: 200 });
  }) as typeof fetch;
}

const baseConfig = { secretApiKey: "test-secret-key", monthlyProductId: undefined, lifetimeProductId: undefined };

describe("retryFailedRevenuecatEventsBatch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("REST照合に成功したイベントはprocessedになりpremiumActiveが反映される", async () => {
    const publicUserId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const userId = await insertUser(publicUserId);
    const event = await insertFailedEvent({ revenueCatEventId: "evt-retry-1", appUserId: publicUserId });
    mockFetchWithSubscriber({ [publicUserId]: { active: true } });

    const result = await retryFailedRevenuecatEventsBatch({ db, config: baseConfig });

    expect(result.succeeded).toBe(1);
    expect(result.stillFailed).toBe(0);

    const [updatedEvent] = await db.select().from(revenuecatEvents).where(eq(revenuecatEvents.id, event.id));
    expect(updatedEvent.processingStatus).toBe("processed");

    const [entitlement] = await db.select().from(subscriptionEntitlements).where(eq(subscriptionEntitlements.userId, userId));
    expect(entitlement.premiumActive).toBe(true);
  });

  it("REST照合が引き続き失敗する場合はfailed_retryableのまま残る", async () => {
    const publicUserId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await insertUser(publicUserId);
    const event = await insertFailedEvent({ revenueCatEventId: "evt-retry-2", appUserId: publicUserId });
    mockFetchWithSubscriber({ [publicUserId]: "error" });

    const result = await retryFailedRevenuecatEventsBatch({ db, config: baseConfig });

    expect(result.stillFailed).toBe(1);
    expect(result.succeeded).toBe(0);

    const [updatedEvent] = await db.select().from(revenuecatEvents).where(eq(revenuecatEvents.id, event.id));
    expect(updatedEvent.processingStatus).toBe("failed_retryable");
  });

  it("Secret API Key未設定の場合もfailed_retryableのまま残る（イベント推測で状態変更しない）", async () => {
    const publicUserId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    await insertUser(publicUserId);
    const event = await insertFailedEvent({ revenueCatEventId: "evt-retry-3", appUserId: publicUserId });
    mockFetchWithSubscriber({ [publicUserId]: { active: true } });

    const result = await retryFailedRevenuecatEventsBatch({
      db,
      config: { secretApiKey: undefined, monthlyProductId: undefined, lifetimeProductId: undefined },
    });

    expect(result.stillFailed).toBe(1);
    const [updatedEvent] = await db.select().from(revenuecatEvents).where(eq(revenuecatEvents.id, event.id));
    expect(updatedEvent.processingStatus).toBe("failed_retryable");
  });

  it("original_app_user_id・aliasesからも解決できる", async () => {
    const publicUserId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const userId = await insertUser(publicUserId);
    const event = await insertFailedEvent({
      revenueCatEventId: "evt-retry-4",
      appUserId: "$RCAnonymousID:abc123",
      originalAppUserId: publicUserId,
    });
    mockFetchWithSubscriber({ [publicUserId]: { active: true } });

    const result = await retryFailedRevenuecatEventsBatch({ db, config: baseConfig });

    expect(result.succeeded).toBe(1);
    const [updatedEvent] = await db.select().from(revenuecatEvents).where(eq(revenuecatEvents.id, event.id));
    expect(updatedEvent.processingStatus).toBe("processed");
    const [entitlement] = await db.select().from(subscriptionEntitlements).where(eq(subscriptionEntitlements.userId, userId));
    expect(entitlement.premiumActive).toBe(true);
  });

  it("未知ユーザーのままのイベントはignored_unknown_userへ変更され、以後の再試行対象から外れる", async () => {
    const event = await insertFailedEvent({
      revenueCatEventId: "evt-retry-5",
      appUserId: "99999999-9999-9999-9999-999999999999",
    });

    const result = await retryFailedRevenuecatEventsBatch({ db, config: baseConfig });

    expect(result.resolvedUnknownUser).toBe(1);
    const [updatedEvent] = await db.select().from(revenuecatEvents).where(eq(revenuecatEvents.id, event.id));
    expect(updatedEvent.processingStatus).toBe("ignored_unknown_user");

    // 2回目のバッチ実行では、既にignored_unknown_userになっているため再試行対象に含まれない。
    const secondResult = await retryFailedRevenuecatEventsBatch({ db, config: baseConfig });
    expect(secondResult.scanned).toBe(0);
  });

  it("TRANSFERコンテキスト（transferred_from/to）が保存されていない古い行は自動再試行の対象外としてスキップされる", async () => {
    const publicUserId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    await insertUser(publicUserId);
    const event = await insertFailedEvent({
      revenueCatEventId: "evt-retry-transfer-no-context",
      eventType: "TRANSFER",
      appUserId: publicUserId,
      // transferredFrom/transferredToをあえて渡さない（この対応より前に失敗した想定）。
    });

    const result = await retryFailedRevenuecatEventsBatch({ db, config: baseConfig });

    expect(result.skippedTransferNoContext).toBe(1);
    const [updatedEvent] = await db.select().from(revenuecatEvents).where(eq(revenuecatEvents.id, event.id));
    expect(updatedEvent.processingStatus).toBe("failed_retryable"); // 手動対応待ちのまま変更しない
  });

  describe("TRANSFERイベントの自動再試行（コンテキスト保存あり）", () => {
    it("移行元A→移行先Bの双方をREST再照合し、成功するとprocessedになる", async () => {
      const userA = "a0000000-0000-0000-0000-000000000001";
      const userB = "b0000000-0000-0000-0000-000000000002";
      const idA = await insertUser(userA);
      const idB = await insertUser(userB);
      const event = await insertFailedEvent({
        revenueCatEventId: "evt-transfer-ab",
        eventType: "TRANSFER",
        appUserId: userB,
        transferredFrom: [userA],
        transferredTo: [userB],
      });
      mockFetchWithSubscriber({ [userA]: { active: false }, [userB]: { active: true } });

      const result = await retryFailedRevenuecatEventsBatch({ db, config: baseConfig });

      expect(result.succeeded).toBe(1);
      const [updatedEvent] = await db.select().from(revenuecatEvents).where(eq(revenuecatEvents.id, event.id));
      expect(updatedEvent.processingStatus).toBe("processed");
      const [entA] = await db.select().from(subscriptionEntitlements).where(eq(subscriptionEntitlements.userId, idA));
      const [entB] = await db.select().from(subscriptionEntitlements).where(eq(subscriptionEntitlements.userId, idB));
      expect(entA.premiumActive).toBe(false);
      expect(entB.premiumActive).toBe(true);
    });

    it("REST一時失敗後、次のCronバッチで成功する", async () => {
      const userA = "a0000000-0000-0000-0000-000000000003";
      const userB = "b0000000-0000-0000-0000-000000000004";
      await insertUser(userA);
      const idB = await insertUser(userB);
      const event = await insertFailedEvent({
        revenueCatEventId: "evt-transfer-retry-success",
        eventType: "TRANSFER",
        appUserId: userB,
        transferredFrom: [userA],
        transferredTo: [userB],
      });

      mockFetchWithSubscriber({ [userA]: "error", [userB]: { active: true } });
      const first = await retryFailedRevenuecatEventsBatch({ db, config: baseConfig });
      expect(first.stillFailed).toBe(1);
      const [afterFirst] = await db.select().from(revenuecatEvents).where(eq(revenuecatEvents.id, event.id));
      expect(afterFirst.processingStatus).toBe("failed_retryable"); // まだ再試行対象

      mockFetchWithSubscriber({ [userA]: { active: false }, [userB]: { active: true } });
      const second = await retryFailedRevenuecatEventsBatch({ db, config: baseConfig });
      expect(second.succeeded).toBe(1);
      const [afterSecond] = await db.select().from(revenuecatEvents).where(eq(revenuecatEvents.id, event.id));
      expect(afterSecond.processingStatus).toBe("processed");
      const [entB] = await db.select().from(subscriptionEntitlements).where(eq(subscriptionEntitlements.userId, idB));
      expect(entB.premiumActive).toBe(true);
    });

    it("移行元のみ未知ユーザーでも、既知の移行先だけ処理してprocessedになる", async () => {
      const unknownFrom = "99999999-1111-1111-1111-111111111111";
      const userB = "b0000000-0000-0000-0000-000000000005";
      const idB = await insertUser(userB);
      const event = await insertFailedEvent({
        revenueCatEventId: "evt-transfer-unknown-from",
        eventType: "TRANSFER",
        appUserId: userB,
        transferredFrom: [unknownFrom],
        transferredTo: [userB],
      });
      mockFetchWithSubscriber({ [userB]: { active: true } });

      const result = await retryFailedRevenuecatEventsBatch({ db, config: baseConfig });

      expect(result.succeeded).toBe(1);
      const [updatedEvent] = await db.select().from(revenuecatEvents).where(eq(revenuecatEvents.id, event.id));
      expect(updatedEvent.processingStatus).toBe("processed");
      const [entB] = await db.select().from(subscriptionEntitlements).where(eq(subscriptionEntitlements.userId, idB));
      expect(entB.premiumActive).toBe(true);
    });

    it("移行先のみ未知ユーザーでも、既知の移行元だけ処理してprocessedになる", async () => {
      const userA = "a0000000-0000-0000-0000-000000000006";
      const unknownTo = "99999999-2222-2222-2222-222222222222";
      const idA = await insertUser(userA);
      const event = await insertFailedEvent({
        revenueCatEventId: "evt-transfer-unknown-to",
        eventType: "TRANSFER",
        appUserId: userA,
        transferredFrom: [userA],
        transferredTo: [unknownTo],
      });
      mockFetchWithSubscriber({ [userA]: { active: false } });

      const result = await retryFailedRevenuecatEventsBatch({ db, config: baseConfig });

      expect(result.succeeded).toBe(1);
      const [updatedEvent] = await db.select().from(revenuecatEvents).where(eq(revenuecatEvents.id, event.id));
      expect(updatedEvent.processingStatus).toBe("processed");
      const [entA] = await db.select().from(subscriptionEntitlements).where(eq(subscriptionEntitlements.userId, idA));
      expect(entA.premiumActive).toBe(false);
    });

    it("同一TRANSFERイベントに対しCronバッチを2回連続実行しても二重反映・エラーにならない", async () => {
      const userA = "a0000000-0000-0000-0000-000000000007";
      const userB = "b0000000-0000-0000-0000-000000000008";
      await insertUser(userA);
      const idB = await insertUser(userB);
      await insertFailedEvent({
        revenueCatEventId: "evt-transfer-double-cron",
        eventType: "TRANSFER",
        appUserId: userB,
        transferredFrom: [userA],
        transferredTo: [userB],
      });
      mockFetchWithSubscriber({ [userA]: { active: false }, [userB]: { active: true } });

      const first = await retryFailedRevenuecatEventsBatch({ db, config: baseConfig });
      expect(first.succeeded).toBe(1);

      // 2回目のバッチ（同一イベントは既にprocessedのため再試行対象に含まれない＝二重処理されない）。
      const second = await retryFailedRevenuecatEventsBatch({ db, config: baseConfig });
      expect(second.scanned).toBe(0);

      const [entB] = await db.select().from(subscriptionEntitlements).where(eq(subscriptionEntitlements.userId, idB));
      expect(entB.premiumActive).toBe(true); // 状態は1回分のみ反映されている
    });

    it("event_timestampが既存のlastRevenueCatEventAtより古い場合はTRANSFER側もsupersededになる（順序逆転ガード）", async () => {
      const userA = "a0000000-0000-0000-0000-000000000009";
      const userB = "b0000000-0000-0000-0000-00000000000a";
      await insertUser(userA);
      const idB = await insertUser(userB);
      const now = Date.now();

      // Bには既に新しい状態（別の後続イベントで反映済み）がある。
      await db.insert(subscriptionEntitlements).values({
        userId: idB,
        entitlementId: "premium",
        premiumActive: true,
        lastRevenueCatEventAt: new Date(now + 10_000).toISOString(),
        source: "webhook",
      });

      await insertFailedEvent({
        revenueCatEventId: "evt-transfer-stale",
        eventType: "TRANSFER",
        appUserId: userB,
        transferredFrom: [userA],
        transferredTo: [userB],
        eventTimestamp: new Date(now).toISOString(), // 上記より古い
      });
      mockFetchWithSubscriber({ [userA]: { active: false }, [userB]: { active: false } }); // 遅延到着のTRANSFERはinactiveを主張

      const result = await retryFailedRevenuecatEventsBatch({ db, config: baseConfig });

      expect(result.succeeded).toBe(1); // superseded扱いも「処理完了」としてカウント
      const [entB] = await db.select().from(subscriptionEntitlements).where(eq(subscriptionEntitlements.userId, idB));
      expect(entB.premiumActive).toBe(true); // 新しい状態が古いTRANSFERで上書きされていない
    });
  });

  it("event_timestampが既存のlastRevenueCatEventAtより古い場合はsupersededになる（順序逆転ガード）", async () => {
    const publicUserId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const userId = await insertUser(publicUserId);
    const now = Date.now();

    // 既に新しい状態（イベント順序が新しい）が反映済みの状況を作る。
    await db.insert(subscriptionEntitlements).values({
      userId,
      entitlementId: "premium",
      premiumActive: false,
      lastRevenueCatEventAt: new Date(now + 10_000).toISOString(),
      source: "webhook",
    });

    const event = await insertFailedEvent({
      revenueCatEventId: "evt-retry-stale",
      appUserId: publicUserId,
      eventTimestamp: new Date(now).toISOString(), // 上記より古い
    });
    mockFetchWithSubscriber({ [publicUserId]: { active: true } });

    const result = await retryFailedRevenuecatEventsBatch({ db, config: baseConfig });

    expect(result.succeeded).toBe(1); // supersededも「処理完了」として扱う
    const [updatedEvent] = await db.select().from(revenuecatEvents).where(eq(revenuecatEvents.id, event.id));
    expect(updatedEvent.processingStatus).toBe("superseded");
    const [entitlement] = await db.select().from(subscriptionEntitlements).where(eq(subscriptionEntitlements.userId, userId));
    expect(entitlement.premiumActive).toBe(false); // 新しい状態が上書きされていない
  });

  it("複数のfailed_retryableイベントを1バッチでまとめて処理する", async () => {
    const userA = "11111111-2222-3333-4444-555555555555";
    const userB = "22222222-3333-4444-5555-666666666666";
    await insertUser(userA);
    await insertUser(userB);
    await insertFailedEvent({ revenueCatEventId: "evt-batch-1", appUserId: userA });
    await insertFailedEvent({ revenueCatEventId: "evt-batch-2", appUserId: userB });
    mockFetchWithSubscriber({ [userA]: { active: true }, [userB]: { active: false } });

    const result = await retryFailedRevenuecatEventsBatch({ db, config: baseConfig });

    expect(result.scanned).toBe(2);
    expect(result.succeeded).toBe(2);
  });
});
