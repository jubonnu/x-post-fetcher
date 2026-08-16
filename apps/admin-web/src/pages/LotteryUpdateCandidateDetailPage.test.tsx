import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LotteryUpdateCandidateDetailPage } from "./LotteryUpdateCandidateDetailPage";
import * as client from "../api/client";
import type { LotteryRow, LotteryUpdateCandidateDetailResponse, LotteryUpdateCandidateRow } from "../types";

function makeCandidate(overrides: Partial<LotteryUpdateCandidateRow> = {}): LotteryUpdateCandidateRow {
  return {
    id: 1,
    targetLotteryId: 100,
    sourcePostId: 200,
    candidateIndex: 0,
    candidateKey: "p:商品|s:店舗",
    matchScore: "70",
    matchReason: "score_review",
    extractedData: "{}",
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

function makeLottery(overrides: Partial<LotteryRow> = {}): LotteryRow {
  return {
    id: 100,
    sourcePostId: null,
    productNameRaw: "既存商品",
    normalizedProductName: "既存商品",
    storeNameRaw: "既存店舗",
    normalizedStoreName: "既存店舗",
    applicationEndAt: null,
    applicationEndDate: null,
    resultAnnouncementAt: null,
    resultAnnouncementDate: null,
    purchaseDeadlineAt: null,
    applicationUrl: null,
    resolvedApplicationUrl: null,
    applicationMethod: null,
    imageUrl: null,
    verificationStatus: "extracted",
    approvedBy: null,
    approvedAt: null,
    rejectedReason: null,
    rejectedAt: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

function makeDetail(overrides: Partial<LotteryUpdateCandidateDetailResponse> = {}): LotteryUpdateCandidateDetailResponse {
  return {
    candidate: makeCandidate(),
    targetLottery: makeLottery(),
    extractedData: { productNameRaw: "既存商品", normalizedProductName: "既存商品" } as never,
    addableFields: [{ fieldName: "region", oldValue: null, newValue: "関西", changeType: "updated" }],
    overwritableFields: [],
    conflictingFields: [{ fieldName: "applicationUrl", oldValue: "https://old.example.com", newValue: "https://new.example.com", changeType: "conflicting" }],
    matchingFields: ["normalizedProductName"],
    newSourcePost: { id: 200, externalPostId: "999", sourceUrl: "https://x.com/test/999", bodyRaw: "本文", publishedAt: "2026-08-01T00:00:00.000Z" },
    existingSourcePost: { id: 199, externalPostId: "998", sourceUrl: "https://x.com/test/998", bodyRaw: "本文2", publishedAt: "2026-07-01T00:00:00.000Z" },
    ...overrides,
  };
}

function renderPage(id: number | string = 1) {
  return render(
    <MemoryRouter initialEntries={["/", `/update-candidates/${id}`]} initialIndex={1}>
      <Routes>
        <Route path="/update-candidates/:id" element={<LotteryUpdateCandidateDetailPage />} />
        <Route path="/" element={<div>一覧画面</div>} />
        <Route path="/update-candidates" element={<div>更新候補一覧画面</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("LotteryUpdateCandidateDetailPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("追加可能・競合フィールドを表示し、追加可能は既定でチェックされている", async () => {
    vi.spyOn(client, "apiRequest").mockResolvedValue(makeDetail());

    renderPage();

    expect(await screen.findByText("地域")).toBeInTheDocument();
    expect(screen.getByText("応募URL")).toBeInTheDocument();

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    // addable(region)は既定チェック、conflicting(applicationUrl)は既定未チェック
    expect(checkboxes[0].checked).toBe(true);
    expect(checkboxes[1].checked).toBe(false);
  });

  it("選択したフィールドのみをapplyへ送信する", async () => {
    const apiRequestSpy = vi.spyOn(client, "apiRequest").mockResolvedValue(makeDetail());

    renderPage();
    await screen.findByText("地域");

    fireEvent.click(screen.getByRole("button", { name: "選択したフィールドを既存抽選へ反映" }));

    await waitFor(() =>
      expect(apiRequestSpy).toHaveBeenCalledWith("/admin/lottery-update-candidates/1/apply", {
        method: "POST",
        body: { fields: ["region"] },
      })
    );
  });

  it("両方の元投稿へのリンクを表示する", async () => {
    vi.spyOn(client, "apiRequest").mockResolvedValue(makeDetail());

    renderPage();

    const existingLink = await screen.findByRole("link", { name: /既存抽選の元投稿を見る/ });
    expect(existingLink).toHaveAttribute("href", "https://x.com/test/998");
    const newLink = screen.getByRole("link", { name: /新しい投稿を見る/ });
    expect(newLink).toHaveAttribute("href", "https://x.com/test/999");
  });

  it("処理済み候補ではアクションボタンを表示しない", async () => {
    vi.spyOn(client, "apiRequest").mockResolvedValue(
      makeDetail({ candidate: makeCandidate({ status: "ignored", resolvedBy: "admin@example.com" }) })
    );

    renderPage();

    await screen.findByText("地域");
    expect(screen.queryByRole("button", { name: "選択したフィールドを既存抽選へ反映" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "無視する" })).not.toBeInTheDocument();
  });
});
