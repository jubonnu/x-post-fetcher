/**
 * Mobile-G2A-Hardening: Apple側トークン失効のCron再試行ジョブ。
 * Apple本物のAPIへは一切通信しない（globalThis.fetchをモック）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.node.ts";
import { createApp } from "../src/app.ts";
import { accountDeletionRequests, users } from "../src/db/schema.ts";
import {
  claimRequestForRetry,
  findAppleRevocationRetryTargets,
} from "../src/repositories/appleRevocationRetryRepository.ts";
import { retryOneAppleRevocation } from "../src/services/appleRevocationService.ts";
import {
  computeNextRetryAt,
  computeStaleThreshold,
  APPLE_REVOCATION_MAX_ATTEMPTS,
  DEFAULT_APPLE_REVOCATION_PROCESSING_TIMEOUT_MINUTES,
} from "../src/services/appleRevocationBackoff.ts";
import { createUserWithAppleIdentityAtomic } from "../src/repositories/userRepository.ts";
import { encryptToken } from "../src/auth/tokenEncryption.ts";
import type { Env } from "../src/env.ts";

const DB_FILE = resolve(process.cwd(), `.tmp-apple-retry-${Date.now()}.db`);

function randomBase64Key(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const CURRENT_KEY_BASE64 = randomBase64Key();
const PREVIOUS_KEY_BASE64 = randomBase64Key();
const originalFetch = globalThis.fetch;

let app: ReturnType<typeof createApp>;
const db = createDb({ TURSO_DATABASE_URL: `file:${DB_FILE}` });

function testEnv(): Env {
  return {
    TURSO_DATABASE_URL: `file:${DB_FILE}`,
    INGEST_TOKEN: "test-token",
    ENVIRONMENT: "test",
    APPLE_CLIENT_ID: "com.cardhub.mobile.test",
    JWT_SIGNING_KEY_CURRENT_KID: "v1",
    JWT_SIGNING_KEY_CURRENT_SECRET: "test-current-secret-not-for-production",
    ACCOUNT_DELETION_GRACE_DAYS: "14",
    APPLE_TEAM_ID: "TEAMTEST01",
    APPLE_KEY_ID: "KEYTEST01",
    APPLE_PRIVATE_KEY: process.env.__TEST_APPLE_PRIVATE_KEY_PEM!,
    APPLE_TOKEN_ENCRYPTION_KEY: CURRENT_KEY_BASE64,
    APPLE_TOKEN_ENCRYPTION_KEY_VERSION: "v2",
    APPLE_TOKEN_ENCRYPTION_KEY_PREVIOUS: PREVIOUS_KEY_BASE64,
    APPLE_TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION: "v1",
  };
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });

  const { exportPKCS8, generateKeyPair } = await import("jose");
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  process.env.__TEST_APPLE_PRIVATE_KEY_PEM = await exportPKCS8(privateKey);

  // アプリ自体はHTTPルート経由のテストでのみ使う（process.envベースのenv解決）
  process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
  process.env.INGEST_TOKEN = "test-token";
  process.env.ENVIRONMENT = "test";
  process.env.APPLE_CLIENT_ID = "com.cardhub.mobile.test";
  process.env.JWT_SIGNING_KEY_CURRENT_KID = "v1";
  process.env.JWT_SIGNING_KEY_CURRENT_SECRET = "test-current-secret-not-for-production";
  process.env.ACCOUNT_DELETION_GRACE_DAYS = "14";
  process.env.APPLE_TEAM_ID = "TEAMTEST01";
  process.env.APPLE_KEY_ID = "KEYTEST01";
  process.env.APPLE_PRIVATE_KEY = process.env.__TEST_APPLE_PRIVATE_KEY_PEM;
  process.env.APPLE_TOKEN_ENCRYPTION_KEY = CURRENT_KEY_BASE64;
  process.env.APPLE_TOKEN_ENCRYPTION_KEY_VERSION = "v2";
  process.env.APPLE_TOKEN_ENCRYPTION_KEY_PREVIOUS = PREVIOUS_KEY_BASE64;
  process.env.APPLE_TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION = "v1";

  app = createApp(createDb);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  rmSync(DB_FILE);
});

/** テスト用: 失敗して再試行待ちになっているaccount_deletion_requests行を、関連ユーザーごと作成する。 */
async function seedFailedRetryTarget(params: {
  sub: string;
  attempts?: number;
  nextRetryAt?: string | null;
  hasToken?: boolean;
  tokenKeyVersion?: "v1" | "v2";
}): Promise<{ userId: number; requestId: number }> {
  const hasToken = params.hasToken ?? true;

  let encryptedToken: { ciphertextBase64: string; ivBase64: string; keyVersion: string } | undefined;
  if (hasToken) {
    const keyVersion = params.tokenKeyVersion ?? "v2";
    const keyBytes =
      keyVersion === "v2"
        ? Uint8Array.from(atob(CURRENT_KEY_BASE64), (c) => c.charCodeAt(0))
        : Uint8Array.from(atob(PREVIOUS_KEY_BASE64), (c) => c.charCodeAt(0));
    const encrypted = await encryptToken(`mock-apple-refresh-token-${params.sub}`, {
      current: { version: keyVersion, keyBytes },
    });
    encryptedToken = encrypted;
  }

  const { user } = await createUserWithAppleIdentityAtomic(db, {
    profile: { sub: params.sub },
    encryptedAppleToken: encryptedToken,
    device: { deviceId: `seed-device-${params.sub}` },
    audit: {},
  });

  const nowIso = new Date().toISOString();
  const [request] = await db
    .insert(accountDeletionRequests)
    .values({
      userId: user.id,
      requestedAt: nowIso,
      scheduledDeletionAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      status: "pending",
      appleRevocationStatus: "failed_will_retry",
      appleRevocationAttempts: params.attempts ?? 1,
      appleRevocationNextRetryAt: params.nextRetryAt === undefined ? new Date(0).toISOString() : params.nextRetryAt,
    })
    .returning();

  return { userId: user.id, requestId: request.id };
}

describe("performAppleRevocationAttempt / retryOneAppleRevocation", () => {
  it("失効に成功するとsucceededになる", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/auth/revoke")) return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { requestId } = await seedFailedRetryTarget({ sub: "retry-succeed" });
    const outcome = await retryOneAppleRevocation({ db, env: testEnv(), requestId });

    expect(outcome.outcome).toBe("succeeded");
    const [row] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, requestId));
    expect(row.appleRevocationStatus).toBe("succeeded");
    expect(row.appleRevocationNextRetryAt).toBeNull();
  });

  it("invalid_grant（既に無効）は成功扱いになる", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;

    const { requestId } = await seedFailedRetryTarget({ sub: "retry-invalid-grant" });
    const outcome = await retryOneAppleRevocation({ db, env: testEnv(), requestId });

    expect(outcome.outcome).toBe("succeeded");
    const [row] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, requestId));
    expect(row.appleRevocationStatus).toBe("succeeded");
  });

  it("一時的なApple API障害はfailed_will_retryのまま残り、次回再試行時刻が設定される", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "server_error" }), { status: 500 })) as typeof fetch;

    const { requestId } = await seedFailedRetryTarget({ sub: "retry-transient-fail", attempts: 1 });
    const before = Date.now();
    const outcome = await retryOneAppleRevocation({ db, env: testEnv(), requestId });

    expect(outcome.outcome).toBe("failed");
    const [row] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, requestId));
    expect(row.appleRevocationStatus).toBe("failed_will_retry");
    expect(row.appleRevocationAttempts).toBe(2);
    expect(row.appleRevocationNextRetryAt).toEqual(expect.any(String));
    expect(new Date(row.appleRevocationNextRetryAt!).getTime()).toBeGreaterThan(before);
  });

  it("次回再試行時刻は指数バックオフで計算される", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const t1 = computeNextRetryAt(1, from);
    const t2 = computeNextRetryAt(2, from);
    const t3 = computeNextRetryAt(3, from);

    expect(new Date(t1).getTime() - from.getTime()).toBe(5 * 60_000);
    expect(new Date(t2).getTime() - from.getTime()).toBe(10 * 60_000);
    expect(new Date(t3).getTime() - from.getTime()).toBe(20 * 60_000);
  });

  it("最大回数に到達するとfailed_permanentlyになり、再試行対象から外れる", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "server_error" }), { status: 500 })) as typeof fetch;

    const { requestId } = await seedFailedRetryTarget({ sub: "retry-max-attempts", attempts: APPLE_REVOCATION_MAX_ATTEMPTS - 1 });
    const outcome = await retryOneAppleRevocation({ db, env: testEnv(), requestId });

    expect(outcome.outcome).toBe("failed");
    const [row] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, requestId));
    expect(row.appleRevocationStatus).toBe("failed_permanently");
    expect(row.appleRevocationAttempts).toBe(APPLE_REVOCATION_MAX_ATTEMPTS);
    expect(row.appleRevocationNextRetryAt).toBeNull();

    const targets = await findAppleRevocationRetryTargets(db, { now: new Date(Date.now() + 999 * 24 * 60 * 60 * 1000).toISOString() });
    expect(targets.find((t) => t.id === requestId)).toBeUndefined();
  });

  it("同時実行時、片方だけがクレームでき、Apple APIは1回しか呼ばれない", async () => {
    let revokeCallCount = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/auth/revoke")) {
        revokeCallCount += 1;
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { requestId } = await seedFailedRetryTarget({ sub: "retry-concurrent" });

    const [outcomeA, outcomeB] = await Promise.all([
      retryOneAppleRevocation({ db, env: testEnv(), requestId }),
      retryOneAppleRevocation({ db, env: testEnv(), requestId }),
    ]);

    const outcomes = [outcomeA.outcome, outcomeB.outcome].sort();
    expect(outcomes).toEqual(["skipped_claimed_elsewhere", "succeeded"]);
    expect(revokeCallCount).toBe(1);
  });

  it("旧バージョンの暗号鍵で保存されたトークンも復号できる", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;

    const { requestId } = await seedFailedRetryTarget({ sub: "retry-old-key-version", tokenKeyVersion: "v1" });
    const outcome = await retryOneAppleRevocation({ db, env: testEnv(), requestId });

    expect(outcome.outcome).toBe("succeeded");
  });

  it("対象ユーザーが既に物理削除済みの場合はnot_applicableになる", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ユーザーが存在しないのでApple APIへ通信すべきではない");
    }) as typeof fetch;

    const { userId, requestId } = await seedFailedRetryTarget({ sub: "retry-user-deleted" });
    await db.delete(users).where(eq(users.id, userId));

    const outcome = await retryOneAppleRevocation({ db, env: testEnv(), requestId });
    expect(outcome.outcome).toBe("not_applicable");

    const [row] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, requestId));
    expect(row.appleRevocationStatus).toBe("not_applicable");
  });

  it("Apple Refresh Tokenが存在しない場合はnot_applicableになる", async () => {
    globalThis.fetch = (async () => {
      throw new Error("トークンが無いのでApple APIへ通信すべきではない");
    }) as typeof fetch;

    const { requestId } = await seedFailedRetryTarget({ sub: "retry-no-token", hasToken: false });
    const outcome = await retryOneAppleRevocation({ db, env: testEnv(), requestId });

    expect(outcome.outcome).toBe("not_applicable");
  });
});

describe("findAppleRevocationRetryTargets / claimRequestForRetry", () => {
  it("staleThresholdを渡すと、stale化したprocessing行も対象に含める", async () => {
    const { requestId } = await seedFailedRetryTarget({ sub: "retry-target-stale-processing" });
    await claimRequestForRetry(db, requestId, computeStaleThreshold(DEFAULT_APPLE_REVOCATION_PROCESSING_TIMEOUT_MINUTES));

    const withoutStale = await findAppleRevocationRetryTargets(db, {});
    expect(withoutStale.find((t) => t.id === requestId)).toBeUndefined(); // processing中は対象外

    const withStale = await findAppleRevocationRetryTargets(db, { staleThreshold: computeStaleThreshold(-1) });
    expect(withStale.find((t) => t.id === requestId)).toBeDefined(); // staleとして対象に含まれる
  });

  it("次回再試行時刻が未来の対象は取得されない", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { requestId } = await seedFailedRetryTarget({ sub: "retry-not-yet-due", nextRetryAt: future });

    const targets = await findAppleRevocationRetryTargets(db, { now: new Date().toISOString() });
    expect(targets.find((t) => t.id === requestId)).toBeUndefined();
  });

  it("既にprocessing/succeeded等の行はクレームできない", async () => {
    const { requestId } = await seedFailedRetryTarget({ sub: "retry-claim-once" });
    const staleThreshold = computeStaleThreshold(DEFAULT_APPLE_REVOCATION_PROCESSING_TIMEOUT_MINUTES);

    const first = await claimRequestForRetry(db, requestId, staleThreshold);
    expect(first).not.toBeNull();

    const second = await claimRequestForRetry(db, requestId, staleThreshold);
    expect(second).toBeNull();
  });

  it("stale判定時間を超えたprocessing行は別Workerが再クレームできる（claimIdが更新される）", async () => {
    const { requestId } = await seedFailedRetryTarget({ sub: "retry-stale-reclaim" });

    // 通常のstale閾値（30分前）では、たった今processingになった行はまだstaleではない
    const notYetStale = computeStaleThreshold(DEFAULT_APPLE_REVOCATION_PROCESSING_TIMEOUT_MINUTES);
    const first = await claimRequestForRetry(db, requestId, notYetStale);
    expect(first).not.toBeNull();

    const stillFresh = await claimRequestForRetry(db, requestId, notYetStale);
    expect(stillFresh).toBeNull(); // まだstaleではないので再クレームできない

    // stale閾値を「1分前」まで短く見せかけることで、経過0秒のprocessing行でもstale扱いにする
    const forcedStale = computeStaleThreshold(-1); // 1分後の時刻 = 閾値が未来 → 現在のprocessingStartedAtは必ずこれより前
    const reclaimed = await claimRequestForRetry(db, requestId, forcedStale);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.claimId).not.toBe(first!.claimId);
  });

  it("stale再クレーム後、古いWorkerが遅れて完了報告しても新しい処理結果を上書きしない（フェンシング）", async () => {
    const { requestId } = await seedFailedRetryTarget({ sub: "retry-fencing" });
    const forcedStale = computeStaleThreshold(-1);

    const oldClaim = await claimRequestForRetry(db, requestId, computeStaleThreshold(DEFAULT_APPLE_REVOCATION_PROCESSING_TIMEOUT_MINUTES));
    expect(oldClaim).not.toBeNull();

    const newClaim = await claimRequestForRetry(db, requestId, forcedStale);
    expect(newClaim).not.toBeNull();
    expect(newClaim!.claimId).not.toBe(oldClaim!.claimId);

    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;

    // 古いWorker（oldClaim.claimId）が今頃になって成功報告を試みる → フェンシングされ無視される
    const { performAppleRevocationAttempt } = await import("../src/services/appleRevocationService.ts");
    const staleOutcome = await performAppleRevocationAttempt({
      db,
      env: testEnv(),
      userId: oldClaim!.row.userId,
      requestId,
      claimId: oldClaim!.claimId,
    });
    expect(staleOutcome.outcome).toBe("fenced");

    // 新しいWorker（newClaim.claimId）の結果は正常に反映される
    const newOutcome = await performAppleRevocationAttempt({
      db,
      env: testEnv(),
      userId: newClaim!.row.userId,
      requestId,
      claimId: newClaim!.claimId,
    });
    expect(newOutcome.outcome).toBe("succeeded");

    const [row] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, requestId));
    expect(row.appleRevocationStatus).toBe("succeeded");
  });

  it("stale再クレーム後の失敗はretryCountを二重加算せず、nextRetryAtを正しく更新する", async () => {
    const { requestId } = await seedFailedRetryTarget({ sub: "retry-no-double-count", attempts: 1 });
    const forcedStale = computeStaleThreshold(-1);

    const oldClaim = await claimRequestForRetry(db, requestId, computeStaleThreshold(DEFAULT_APPLE_REVOCATION_PROCESSING_TIMEOUT_MINUTES));
    const newClaim = await claimRequestForRetry(db, requestId, forcedStale);
    expect(oldClaim).not.toBeNull();
    expect(newClaim).not.toBeNull();

    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "server_error" }), { status: 500 })) as typeof fetch;

    const { performAppleRevocationAttempt } = await import("../src/services/appleRevocationService.ts");
    // 新しいWorkerのみが実際に処理する
    const newOutcome = await performAppleRevocationAttempt({
      db,
      env: testEnv(),
      userId: newClaim!.row.userId,
      requestId,
      claimId: newClaim!.claimId,
    });
    expect(newOutcome.outcome).toBe("failed");

    const [row] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, requestId));
    expect(row.appleRevocationAttempts).toBe(2); // 1(seed) + 1(今回) のみ、二重加算されない
    expect(row.appleRevocationNextRetryAt).toEqual(expect.any(String));

    // 古いWorkerが後から失敗報告してもフェンシングされ、attemptsは変化しない
    const staleOutcome = await performAppleRevocationAttempt({
      db,
      env: testEnv(),
      userId: oldClaim!.row.userId,
      requestId,
      claimId: oldClaim!.claimId,
    });
    expect(staleOutcome.outcome).toBe("fenced");

    const [rowAfter] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, requestId));
    expect(rowAfter.appleRevocationAttempts).toBe(2); // 変化なし
  });

  it("succeeded/failed_permanentlyの行はstale判定時間を超えても再クレームされない", async () => {
    const { requestId } = await seedFailedRetryTarget({ sub: "retry-terminal-no-reclaim" });
    const staleThreshold = computeStaleThreshold(DEFAULT_APPLE_REVOCATION_PROCESSING_TIMEOUT_MINUTES);
    const claimed = await claimRequestForRetry(db, requestId, staleThreshold);
    expect(claimed).not.toBeNull();

    await db
      .update(accountDeletionRequests)
      .set({ appleRevocationStatus: "succeeded" })
      .where(eq(accountDeletionRequests.id, requestId));

    const forcedStale = computeStaleThreshold(-1);
    const reclaimed = await claimRequestForRetry(db, requestId, forcedStale);
    expect(reclaimed).toBeNull();
  });
});

describe("POST /internal/apple-revocation/retry-batch", () => {
  it("Bearer認証が無ければ401", async () => {
    const res = await app.request("/internal/apple-revocation/retry-batch", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("不正なTokenでも401（既存/internal/*と同じBearer認証方式）", async () => {
    const res = await app.request("/internal/apple-revocation/retry-batch", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token-value" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("バッチで複数件処理し、件数を返す", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
    await seedFailedRetryTarget({ sub: "retry-batch-1" });
    await seedFailedRetryTarget({ sub: "retry-batch-2" });

    const res = await app.request("/internal/apple-revocation/retry-batch", {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.processed).toBeGreaterThanOrEqual(2);
    expect(body.succeeded).toBeGreaterThanOrEqual(2);
  });
});
