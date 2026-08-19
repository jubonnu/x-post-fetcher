import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * known-external-ids照会が失敗した場合、スクレイプ全体を失敗させ、ingestを1件も実行しないことを
 * 検証する（test.md記載の要件: API障害時に初回モードへフォールバックしない）。
 *
 * fetchAndProcessTweets.ts の main() は import 時に自動実行されない
 * （isMainModuleガードにより、CLI実行時（`node src/jobs/fetchAndProcessTweets.ts`）のみ動く）。
 * このテストでは global fetch をモックし、known-external-ids への呼び出しだけ失敗させ、
 * /ingest への呼び出しが一度も発生しないことを確認する。fetchTweets（Playwright起動）まで
 * 到達しないことがこのテストの主眼のため、既知ID照会が失敗した時点で main() が reject することを
 * 確認すれば十分（fetchTweetsをモックする必要はない＝到達しない）。
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.INGEST_URL = "http://localhost:8787/ingest";
  process.env.INGEST_TOKEN = "test-token";
  process.env.TARGET_USER = "zabi_poc";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("main(): known-external-ids照会の失敗", () => {
  it("known IDs API が 500 を返す → main() が失敗し、/ingest は一度も呼ばれない", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/internal/source-posts/known-external-ids")) {
        return new Response(JSON.stringify({ ok: false, error: "internal_error" }), { status: 500 });
      }
      throw new Error(`unexpected fetch call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { main } = await import("../src/jobs/fetchAndProcessTweets.ts");
    await expect(main()).rejects.toThrow(/known-external-idsの取得に失敗/);

    const ingestCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/ingest") && !String(input).includes("known-external-ids"));
    expect(ingestCalls.length).toBe(0);
  });

  it("known IDs API がタイムアウト（ネットワークエラー）→ main() が失敗し、/ingest は一度も呼ばれない", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/internal/source-posts/known-external-ids")) {
        throw new Error("fetch failed: network timeout");
      }
      throw new Error(`unexpected fetch call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { main } = await import("../src/jobs/fetchAndProcessTweets.ts");
    await expect(main()).rejects.toThrow(/known-external-idsの取得に失敗/);

    const ingestCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/ingest") && !String(input).includes("known-external-ids"));
    expect(ingestCalls.length).toBe(0);
  });

  it("known IDs API のレスポンスがJSONとして不正 → main() が失敗し、/ingest は一度も呼ばれない", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/internal/source-posts/known-external-ids")) {
        return new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { main } = await import("../src/jobs/fetchAndProcessTweets.ts");
    await expect(main()).rejects.toThrow(/known-external-idsの取得に失敗/);

    const ingestCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/ingest") && !String(input).includes("known-external-ids"));
    expect(ingestCalls.length).toBe(0);
  });

  it("known IDs API が正常応答（0件配列）の場合は失敗として扱わない（=空集合は正常系、初回モードの根拠）", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/internal/source-posts/known-external-ids")) {
        return new Response(JSON.stringify({ ok: true, externalPostIds: [], needsRecovery: false }), { status: 200 });
      }
      throw new Error(`unexpected fetch call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchKnownExternalPostIds } = await import("../src/jobs/fetchAndProcessTweets.ts");
    const result = await fetchKnownExternalPostIds("http://localhost:8787/ingest", "test-token", "zabi_poc", 200);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.externalPostIds.size).toBe(0);
      expect(result.needsRecovery).toBe(false);
    }
  });
});
