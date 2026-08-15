import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LotteryUpdateCandidateListPage } from "./LotteryUpdateCandidateListPage";
import * as client from "../api/client";
import * as authContext from "../auth/AuthContext";
import type { LotteryUpdateCandidateListResponse, LotteryUpdateCandidateRow } from "../types";

function makeCandidate(overrides: Partial<LotteryUpdateCandidateRow> & { id: number }): LotteryUpdateCandidateRow {
  return {
    targetLotteryId: 100,
    sourcePostId: 200,
    candidateIndex: 0,
    candidateKey: "p:商品|s:店舗",
    matchScore: "70",
    matchReason: "score_review",
    extractedData: JSON.stringify({ productNameRaw: `商品${overrides.id}`, storeNameRaw: `店舗${overrides.id}` }),
    status: "pending",
    resolvedBy: null,
    resolvedAt: null,
    appliedFields: null,
    registeredLotteryId: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/update-candidates"]}>
      <LotteryUpdateCandidateListPage />
    </MemoryRouter>
  );
}

describe("LotteryUpdateCandidateListPage", () => {
  beforeEach(() => {
    vi.spyOn(authContext, "useAuth").mockReturnValue({
      admin: { id: 1, email: "admin@example.com", createdAt: "2026-01-01" },
      loading: false,
      login: vi.fn(),
      signup: vi.fn(),
      changePassword: vi.fn(),
      logout: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("初回表示でpendingタブを取得する", async () => {
    const apiRequestSpy = vi
      .spyOn(client, "apiRequest")
      .mockResolvedValue({ items: [makeCandidate({ id: 1 })], total: 1 } satisfies LotteryUpdateCandidateListResponse);

    renderPage();

    await waitFor(() => expect(apiRequestSpy).toHaveBeenCalled());
    expect(apiRequestSpy).toHaveBeenCalledWith("/admin/lottery-update-candidates?status=pending&limit=20&offset=0");
    expect(await screen.findByText("商品1")).toBeInTheDocument();
    expect(screen.getByText(/要確認（70点）/)).toBeInTheDocument();
  });

  it("タブ切り替えでstatusパラメータが変わる", async () => {
    const apiRequestSpy = vi
      .spyOn(client, "apiRequest")
      .mockResolvedValue({ items: [], total: 0 } satisfies LotteryUpdateCandidateListResponse);

    renderPage();
    await waitFor(() => expect(apiRequestSpy).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "反映済み" }));

    await waitFor(() =>
      expect(apiRequestSpy).toHaveBeenLastCalledWith("/admin/lottery-update-candidates?status=applied&limit=20&offset=0")
    );
  });

  it("候補が無い場合はメッセージを表示する", async () => {
    vi.spyOn(client, "apiRequest").mockResolvedValue({ items: [], total: 0 } satisfies LotteryUpdateCandidateListResponse);

    renderPage();

    expect(await screen.findByText("該当する更新候補はありません")).toBeInTheDocument();
  });
});
