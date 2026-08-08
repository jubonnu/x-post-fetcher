import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";
import * as authContext from "../auth/AuthContext";
import { ApiError } from "../api/client";

function renderLoginPage() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<div>ホーム画面</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("LoginPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("email/passwordを入力してログインに成功すると一覧（/）へ遷移する", async () => {
    const login = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(authContext, "useAuth").mockReturnValue({
      admin: null,
      loading: false,
      login,
      signup: vi.fn(),
      changePassword: vi.fn(),
      logout: vi.fn(),
    });

    renderLoginPage();

    fireEvent.change(screen.getByLabelText("メールアドレス"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("パスワード"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));

    await waitFor(() => expect(login).toHaveBeenCalledWith("a@example.com", "password123"));
    expect(await screen.findByText("ホーム画面")).toBeInTheDocument();
  });

  it("ログイン失敗時はエラーメッセージを表示し、画面遷移しない", async () => {
    const login = vi.fn().mockRejectedValue(new ApiError("UNAUTHORIZED", "メールアドレスまたはパスワードが正しくありません", 401));
    vi.spyOn(authContext, "useAuth").mockReturnValue({
      admin: null,
      loading: false,
      login,
      signup: vi.fn(),
      changePassword: vi.fn(),
      logout: vi.fn(),
    });

    renderLoginPage();

    fireEvent.change(screen.getByLabelText("メールアドレス"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("パスワード"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));

    expect(await screen.findByText("メールアドレスまたはパスワードが正しくありません")).toBeInTheDocument();
    expect(screen.queryByText("ホーム画面")).not.toBeInTheDocument();
  });
});
