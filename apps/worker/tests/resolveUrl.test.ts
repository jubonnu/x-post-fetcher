import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveUrl } from "../src/services/resolveUrl.ts";

/** モックレスポンスを作るヘルパー（redirect: "manual" 対応）。 */
function mockResponse(status: number, location?: string) {
  return {
    status,
    headers: { get: (h: string) => (h.toLowerCase() === "location" ? (location ?? null) : null) },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveUrl", () => {
  it("正常なURLは resolvedUrl と status 200 を返す（リダイレクト追跡）", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(mockResponse(301, "https://example.com/final"))
        .mockResolvedValueOnce(mockResponse(200))
    );
    const r = await resolveUrl("https://t.co/abc123");
    expect(r.resolvedUrl).toBe("https://example.com/final");
    expect(r.httpStatus).toBe(200);
    expect(r.error).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("リダイレクトなし（200 直返し）は元 URL をそのまま返す", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200)));
    const r = await resolveUrl("https://example.com/page");
    expect(r.resolvedUrl).toBe("https://example.com/page");
    expect(r.httpStatus).toBe(200);
    expect(r.error).toBeNull();
  });

  it("HEAD 405 → GET にフォールバックしてリダイレクト追跡", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        // hop=0: HEAD → 405
        .mockResolvedValueOnce(mockResponse(405))
        // hop=0 fallback: GET → 301
        .mockResolvedValueOnce(mockResponse(301, "https://example.com/final"))
        // hop=1: HEAD → 200
        .mockResolvedValueOnce(mockResponse(200))
    );
    const r = await resolveUrl("https://t.co/abc");
    expect(r.resolvedUrl).toBe("https://example.com/final");
    expect(r.httpStatus).toBe(200);
    // 3回 fetch が呼ばれた（HEAD + GET + HEAD）
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("404 は resolvedUrl（現在 URL）と status 404 を返す", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(404)));
    const r = await resolveUrl("https://t.co/missing");
    expect(r.resolvedUrl).toBe("https://t.co/missing");
    expect(r.httpStatus).toBe(404);
    expect(r.error).toBeNull();
  });

  it("ネットワークエラーは resolvedUrl=null・error に記録", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const r = await resolveUrl("https://t.co/fail");
    expect(r.resolvedUrl).toBeNull();
    expect(r.httpStatus).toBeNull();
    expect(r.error).toContain("network error");
  });

  it("AbortError はタイムアウトとして error='timeout'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        return new Promise((_, reject) => {
          opts.signal?.addEventListener("abort", () => {
            const e = new DOMException("aborted", "AbortError");
            reject(e);
          });
        });
      })
    );
    const r = await resolveUrl("https://t.co/slow", 10); // 10ms タイムアウト
    expect(r.resolvedUrl).toBeNull();
    expect(r.error).toBe("timeout");
  });
});
