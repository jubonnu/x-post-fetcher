import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignupPage } from "./SignupPage";
import * as authContext from "../auth/AuthContext";
import { ApiError } from "../api/client";

function renderSignupPage() {
  return render(
    <MemoryRouter initialEntries={["/signup"]}>
      <Routes>
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/" element={<div>ホーム画面</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("SignupPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("email/password/招待コードを入力して登録に成功すると一覧（/）へ遷移する", async () => {
    const signup = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(authContext, "useAuth").mockReturnValue({
      admin: null,
      loading: false,
      login: vi.fn(),
      signup,
      changePassword: vi.fn(),
      logout: vi.fn(),
    });

    renderSignupPage();

    fireEvent.change(screen.getByLabelText("メールアドレス"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("パスワード（8文字以上）"), { target: { value: "password123" } });
    fireEvent.change(screen.getByLabelText("招待コード"), { target: { value: "invite-123" } });
    fireEvent.click(screen.getByRole("button", { name: "登録" }));

    await waitFor(() => expect(signup).toHaveBeenCalledWith("a@example.com", "password123", "invite-123"));
    expect(await screen.findByText("ホーム画面")).toBeInTheDocument();
  });

  it("招待コードが違うとエラーメッセージを表示する", async () => {
    const signup = vi.fn().mockRejectedValue(new ApiError("FORBIDDEN", "招待コードが正しくありません", 403));
    vi.spyOn(authContext, "useAuth").mockReturnValue({
      admin: null,
      loading: false,
      login: vi.fn(),
      signup,
      changePassword: vi.fn(),
      logout: vi.fn(),
    });

    renderSignupPage();

    fireEvent.change(screen.getByLabelText("メールアドレス"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("パスワード（8文字以上）"), { target: { value: "password123" } });
    fireEvent.change(screen.getByLabelText("招待コード"), { target: { value: "wrong-code" } });
    fireEvent.click(screen.getByRole("button", { name: "登録" }));

    expect(await screen.findByText("招待コードが正しくありません")).toBeInTheDocument();
  });
});
