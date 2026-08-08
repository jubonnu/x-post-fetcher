import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest, ApiError, clearStoredToken, getStoredToken, setStoredToken } from "./client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("token storage", () => {
  afterEach(() => localStorage.clear());

  it("setStoredToken/getStoredToken/clearStoredTokenが正しく動作する", () => {
    expect(getStoredToken()).toBeNull();
    setStoredToken("token-123");
    expect(getStoredToken()).toBe("token-123");
    clearStoredToken();
    expect(getStoredToken()).toBeNull();
  });
});

describe("apiRequest", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("成功時はJSONレスポンスをそのまま返す", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { hello: "world" }));
    const result = await apiRequest<{ hello: string }>("/admin/lotteries");
    expect(result).toEqual({ hello: "world" });
  });

  it("認証トークンがあればAuthorizationヘッダを付与する", async () => {
    setStoredToken("my-token");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    globalThis.fetch = fetchMock;

    await apiRequest("/admin/lotteries");

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer my-token");
  });

  it("auth: falseを指定するとトークンがあってもAuthorizationヘッダを付けない", async () => {
    setStoredToken("my-token");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    globalThis.fetch = fetchMock;

    await apiRequest("/admin/auth/login", { auth: false });

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("bodyを指定するとJSON化してContent-Type: application/jsonで送る", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    globalThis.fetch = fetchMock;

    await apiRequest("/admin/auth/login", { method: "POST", body: { email: "a@example.com" } });

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ email: "a@example.com" }));
  });

  it("rawBodyを指定するとそのままbodyへ渡し、rawContentTypeをContent-Typeにする", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    globalThis.fetch = fetchMock;
    const blob = new Blob(["fake-image-bytes"]);

    await apiRequest("/admin/lotteries/1/image", { method: "POST", rawBody: blob, rawContentType: "image/png" });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe(blob);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("image/png");
  });

  it("エラーレスポンスはApiErrorとしてcode/message/statusを投げる", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "認証が必要です", requestId: "r1" } }));

    await expect(apiRequest("/admin/lotteries")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "認証が必要です",
      status: 401,
    });
  });

  it("JSON以外のエラーレスポンスでも例外を投げずUNKNOWNコードのApiErrorになる", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500 }));

    let caught: unknown;
    try {
      await apiRequest("/admin/lotteries");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(500);
  });

  it("204 No Contentはundefinedを返す", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const result = await apiRequest("/admin/lotteries/1");
    expect(result).toBeUndefined();
  });
});
