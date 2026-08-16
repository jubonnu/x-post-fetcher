import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LotteryNewPage } from "./LotteryNewPage";
import * as client from "../api/client";
import type { LotteryDetailResponse, LotteryRow } from "../types";

function makeLottery(overrides: Partial<LotteryRow> = {}): LotteryRow {
  return {
    id: 99,
    productNameRaw: "手動追加商品",
    normalizedProductName: null,
    storeNameRaw: "手動追加店舗",
    normalizedStoreName: null,
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
  } as LotteryRow;
}

function renderNewPage(locationState?: unknown) {
  // "戻る"はブラウザ履歴を1つ戻る実装のため、一覧("/")を経由してから遷移してきた状態を再現する
  // （historyが無いとnavigate(-1)が何もしない）。
  return render(
    <MemoryRouter
      initialEntries={["/", { pathname: "/lotteries/new", state: locationState }]}
      initialIndex={1}
    >
      <Routes>
        <Route path="/lotteries/new" element={<LotteryNewPage />} />
        <Route path="/lotteries/:id" element={<div>編集画面</div>} />
        <Route path="/" element={<div>一覧画面</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("LotteryNewPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("タイトル・店舗を入力して作成すると、POST /admin/lotteriesを呼び作成後の編集画面へ遷移する", async () => {
    const apiRequestSpy = vi.spyOn(client, "apiRequest").mockResolvedValue({
      lottery: makeLottery(),
      sources: [],
      fieldHistory: [],
    } satisfies LotteryDetailResponse);

    renderNewPage();

    fireEvent.change(screen.getByLabelText("タイトル *"), { target: { value: "手動追加商品" } });
    fireEvent.change(screen.getByLabelText("店舗 *"), { target: { value: "手動追加店舗" } });
    fireEvent.click(screen.getByRole("button", { name: "作成" }));

    await waitFor(() =>
      expect(apiRequestSpy).toHaveBeenCalledWith(
        "/admin/lotteries",
        expect.objectContaining({
          method: "POST",
          body: expect.objectContaining({ productNameRaw: "手動追加商品", storeNameRaw: "手動追加店舗" }),
        })
      )
    );
    expect(await screen.findByText("編集画面")).toBeInTheDocument();
  });

  it("タイトルが未入力だとAPIを呼ばずエラーメッセージを表示する", async () => {
    const apiRequestSpy = vi.spyOn(client, "apiRequest").mockResolvedValue({
      lottery: makeLottery(),
      sources: [],
      fieldHistory: [],
    } satisfies LotteryDetailResponse);

    renderNewPage();

    fireEvent.change(screen.getByLabelText("店舗 *"), { target: { value: "店舗のみ" } });
    fireEvent.click(screen.getByRole("button", { name: "作成" }));

    expect(await screen.findByText("タイトルと店舗は必須です")).toBeInTheDocument();
    expect(apiRequestSpy).not.toHaveBeenCalled();
  });

  it("API失敗時はエラーメッセージを表示する", async () => {
    vi.spyOn(client, "apiRequest").mockRejectedValue(new client.ApiError("VALIDATION_ERROR", "作成に失敗しました", 422));

    renderNewPage();

    fireEvent.change(screen.getByLabelText("タイトル *"), { target: { value: "商品" } });
    fireEvent.change(screen.getByLabelText("店舗 *"), { target: { value: "店舗" } });
    fireEvent.click(screen.getByRole("button", { name: "作成" }));

    expect(await screen.findByText("作成に失敗しました")).toBeInTheDocument();
  });

  it("キャンセルボタンで一覧へ戻る", async () => {
    renderNewPage();

    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(await screen.findByText("一覧画面")).toBeInTheDocument();
  });

  it("編集画面からの複製（location.state.duplicateFrom）でフォームが事前入力される", async () => {
    const apiRequestSpy = vi.spyOn(client, "apiRequest").mockResolvedValue({
      lottery: makeLottery(),
      sources: [],
      fieldHistory: [],
    } satisfies LotteryDetailResponse);

    renderNewPage({
      duplicateFrom: {
        productNameRaw: "複製元商品",
        storeNameRaw: "複製元店舗",
        applicationStartAt: "2026-09-01T00:00",
        applicationEndAt: "2026-09-10T15:00",
        resultAnnouncementStartAt: "",
        resultAnnouncementAt: "",
        purchaseStartAt: "",
        purchaseDeadlineAt: "",
        applicationMethod: "先着",
        applicationUrls: ["https://example.com/dup"],
      },
    });

    expect(await screen.findByText("抽選を複製して新規作成")).toBeInTheDocument();
    expect(screen.getByLabelText("タイトル *")).toHaveValue("複製元商品");
    expect(screen.getByLabelText("店舗 *")).toHaveValue("複製元店舗");
    expect(screen.getByLabelText("応募開始")).toHaveValue("2026-09-01T00:00");
    expect(screen.getByLabelText("応募締切")).toHaveValue("2026-09-10T15:00");
    expect(screen.getByLabelText("応募ページURL 1")).toHaveValue("https://example.com/dup");

    fireEvent.click(screen.getByRole("button", { name: "作成" }));
    await waitFor(() =>
      expect(apiRequestSpy).toHaveBeenCalledWith(
        "/admin/lotteries",
        expect.objectContaining({
          body: expect.objectContaining({
            productNameRaw: "複製元商品",
            storeNameRaw: "複製元店舗",
            applicationUrls: ["https://example.com/dup"],
          }),
        })
      )
    );
  });
});
