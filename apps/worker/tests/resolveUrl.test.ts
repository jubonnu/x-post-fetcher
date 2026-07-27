import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveUrl } from "../src/services/resolveUrl.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveUrl", () => {
  it("正常なURLは resolvedUrl と status 200 を返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ url: "https://example.com/final", status: 200 })
    );
    const r = await resolveUrl("https://t.co/abc123");
    expect(r.resolvedUrl).toBe("https://example.com/final");
    expect(r.httpStatus).toBe(200);
    expect(r.error).toBeNull();
  });

  it("HEAD 405 → GET にフォールバックして最終 URL を取得", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ url: "https://t.co/abc", status: 405 })
        .mockResolvedValueOnce({ url: "https://example.com/final", status: 200 })
    );
    const r = await resolveUrl("https://t.co/abc");
    expect(r.resolvedUrl).toBe("https://example.com/final");
    expect(r.httpStatus).toBe(200);
    // 2回 fetch が呼ばれた（HEAD + GET）
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("404 は resolvedUrl と status 404 を返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ url: "https://example.com/not-found", status: 404 })
    );
    const r = await resolveUrl("https://t.co/missing");
    expect(r.resolvedUrl).toBe("https://example.com/not-found");
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
