import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangePasswordPage } from "./ChangePasswordPage";
import * as authContext from "../auth/AuthContext";
import { ApiError } from "../api/client";

function mockAuth(changePassword: (currentPassword: string, newPassword: string) => Promise<void>) {
  vi.spyOn(authContext, "useAuth").mockReturnValue({
    admin: { id: 1, email: "a@example.com", createdAt: "2026-01-01" },
    loading: false,
    login: vi.fn(),
    signup: vi.fn(),
    changePassword,
    logout: vi.fn(),
  });
}

describe("ChangePasswordPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("成功すると「パスワードを変更しました」を表示し、入力欄をクリアする", async () => {
    const changePassword = vi.fn().mockResolvedValue(undefined);
    mockAuth(changePassword);

    render(
      <MemoryRouter>
        <ChangePasswordPage />
      </MemoryRouter>
    );

    const currentInput = screen.getByLabelText("現在のパスワード") as HTMLInputElement;
    const newInput = screen.getByLabelText("新しいパスワード（8文字以上）") as HTMLInputElement;
    fireEvent.change(currentInput, { target: { value: "old-password" } });
    fireEvent.change(newInput, { target: { value: "new-password123" } });
    fireEvent.click(screen.getByRole("button", { name: "変更する" }));

    await waitFor(() => expect(changePassword).toHaveBeenCalledWith("old-password", "new-password123"));
    expect(await screen.findByText("パスワードを変更しました")).toBeInTheDocument();
    expect(currentInput.value).toBe("");
    expect(newInput.value).toBe("");
  });

  it("現在のパスワードが違うとエラーメッセージを表示する", async () => {
    const changePassword = vi.fn().mockRejectedValue(new ApiError("UNAUTHORIZED", "現在のパスワードが正しくありません", 401));
    mockAuth(changePassword);

    render(
      <MemoryRouter>
        <ChangePasswordPage />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText("現在のパスワード"), { target: { value: "wrong" } });
    fireEvent.change(screen.getByLabelText("新しいパスワード（8文字以上）"), { target: { value: "new-password123" } });
    fireEvent.click(screen.getByRole("button", { name: "変更する" }));

    expect(await screen.findByText("現在のパスワードが正しくありません")).toBeInTheDocument();
    expect(screen.queryByText("パスワードを変更しました")).not.toBeInTheDocument();
  });
});
