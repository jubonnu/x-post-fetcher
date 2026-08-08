import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";
import { clearStoredToken, getStoredToken } from "../api/client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("AuthProvider / useAuth", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("保存済みトークンが無い場合、loadingがfalseになりadminはnullのまま", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.admin).toBeNull();
  });

  it("保存済みトークンが有効なら/admin/auth/meの結果でadminを復元する", async () => {
    localStorage.setItem("cardhub-admin-token", "existing-token");
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { admin: { id: 1, email: "a@example.com", createdAt: "2026-01-01" } }));

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.admin?.email).toBe("a@example.com");
  });

  it("保存済みトークンが無効（401）なら破棄してadminはnullのまま", async () => {
    localStorage.setItem("cardhub-admin-token", "invalid-token");
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "無効", requestId: "r1" } }));

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.admin).toBeNull();
    expect(getStoredToken()).toBeNull();
  });

  it("loginに成功するとトークンを保存し、adminをセットする", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { token: "new-token", admin: { id: 1, email: "a@example.com", createdAt: "2026-01-01" } }));

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.login("a@example.com", "password123");
    });

    expect(result.current.admin?.email).toBe("a@example.com");
    expect(getStoredToken()).toBe("new-token");
  });

  it("loginに失敗すると例外を投げ、adminはセットされない", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "パスワードが違います", requestId: "r1" } }));

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      act(async () => {
        await result.current.login("a@example.com", "wrong");
      })
    ).rejects.toMatchObject({ message: "パスワードが違います" });

    expect(result.current.admin).toBeNull();
  });

  it("logoutでトークンをクリアし、adminをnullに戻す", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { token: "new-token", admin: { id: 1, email: "a@example.com", createdAt: "2026-01-01" } }));

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.login("a@example.com", "password123");
    });
    expect(result.current.admin).not.toBeNull();

    act(() => {
      result.current.logout();
    });

    expect(result.current.admin).toBeNull();
    expect(getStoredToken()).toBeNull();
  });

  afterEach(() => clearStoredToken());
});
