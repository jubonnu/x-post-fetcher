import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LotteryListPage } from "./LotteryListPage";
import * as client from "../api/client";
import * as authContext from "../auth/AuthContext";
import type { LotteryListResponse, LotteryRow } from "../types";

function makeLottery(overrides: Partial<LotteryRow> & { id: number }): LotteryRow {
  return {
    productNameRaw: `商品${overrides.id}`,
    normalizedProductName: null,
    storeNameRaw: `店舗${overrides.id}`,
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
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <LotteryListPage />
    </MemoryRouter>
  );
}

describe("LotteryListPage", () => {
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

  it("初回表示で「要確認」タブのフィルタで1ページ目を取得する", async () => {
    const apiRequestSpy = vi
      .spyOn(client, "apiRequest")
      .mockResolvedValue({ items: [makeLottery({ id: 1 })], total: 1 } satisfies LotteryListResponse);

    renderPage();

    await waitFor(() => expect(apiRequestSpy).toHaveBeenCalled());
    expect(apiRequestSpy).toHaveBeenCalledWith(
      "/admin/lotteries?excludeVerificationStatuses=approved%2Crejected&limit=20&offset=0"
    );
    expect(await screen.findByText("商品1")).toBeInTheDocument();
  });

  it("「+ 手動で追加」リンクが/lotteries/newを指す", async () => {
    vi.spyOn(client, "apiRequest").mockResolvedValue({ items: [], total: 0 } satisfies LotteryListResponse);

    renderPage();

    const link = await screen.findByRole("link", { name: "+ 手動で追加" });
    expect(link).toHaveAttribute("href", "/lotteries/new");
  });

  it("「承認済み」タブに切り替えるとverificationStatus=approvedで再取得し、ページも0に戻る", async () => {
    const apiRequestSpy = vi
      .spyOn(client, "apiRequest")
      .mockResolvedValue({ items: [], total: 0 } satisfies LotteryListResponse);

    renderPage();
    await waitFor(() => expect(apiRequestSpy).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "承認済み" }));

    await waitFor(() =>
      expect(apiRequestSpy).toHaveBeenLastCalledWith("/admin/lotteries?verificationStatus=approved&limit=20&offset=0")
    );
  });

  it("101件ある場合、ページネーションUIが表示され「次へ」でoffsetが進む", async () => {
    const apiRequestSpy = vi
      .spyOn(client, "apiRequest")
      .mockResolvedValue({ items: [makeLottery({ id: 1 })], total: 101 } satisfies LotteryListResponse);

    renderPage();
    await waitFor(() => expect(apiRequestSpy).toHaveBeenCalledTimes(1));

    expect(screen.getByText("1 / 6")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "次へ" }));

    await waitFor(() =>
      expect(apiRequestSpy).toHaveBeenLastCalledWith(
        "/admin/lotteries?excludeVerificationStatuses=approved%2Crejected&limit=20&offset=20"
      )
    );
    expect(await screen.findByText("2 / 6")).toBeInTheDocument();
  });

  it("total <= 20件ならページネーションUIを表示しない", async () => {
    vi.spyOn(client, "apiRequest").mockResolvedValue({ items: [makeLottery({ id: 1 })], total: 5 } satisfies LotteryListResponse);

    renderPage();
    await screen.findByText("商品1");

    expect(screen.queryByRole("button", { name: "次へ" })).not.toBeInTheDocument();
  });

  it("承認ボタンでPOST /admin/lotteries/:id/approveを呼び、一覧を再取得する", async () => {
    const apiRequestSpy = vi
      .spyOn(client, "apiRequest")
      .mockResolvedValue({ items: [makeLottery({ id: 42, verificationStatus: "extracted" })], total: 1 } satisfies LotteryListResponse);

    renderPage();
    await screen.findByText("商品42");

    fireEvent.click(screen.getByRole("button", { name: "承認" }));

    await waitFor(() => expect(apiRequestSpy).toHaveBeenCalledWith("/admin/lotteries/42/approve", { method: "POST" }));
    // 承認後に一覧の再取得（合計3回: 初回 + 承認 + 再取得）が行われる
    await waitFor(() => expect(apiRequestSpy).toHaveBeenCalledTimes(3));
  });

  it("却下ボタンはwindow.promptで理由を聞き、POST /admin/lotteries/:id/rejectを呼ぶ", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("情報が不正確");
    const apiRequestSpy = vi
      .spyOn(client, "apiRequest")
      .mockResolvedValue({ items: [makeLottery({ id: 7 })], total: 1 } satisfies LotteryListResponse);

    renderPage();
    await screen.findByText("商品7");

    fireEvent.click(screen.getByRole("button", { name: "却下" }));

    await waitFor(() =>
      expect(apiRequestSpy).toHaveBeenCalledWith("/admin/lotteries/7/reject", {
        method: "POST",
        body: { reason: "情報が不正確" },
      })
    );
  });

  it("却下時にwindow.promptをキャンセルすると何も呼ばれない", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    const apiRequestSpy = vi
      .spyOn(client, "apiRequest")
      .mockResolvedValue({ items: [makeLottery({ id: 9 })], total: 1 } satisfies LotteryListResponse);

    renderPage();
    await screen.findByText("商品9");
    const callCountBefore = apiRequestSpy.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "却下" }));

    // 非同期の副作用が起きないことを確認するため、少し待っても呼び出し回数が変わらないことを見る
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(apiRequestSpy.mock.calls.length).toBe(callCountBefore);
  });

  it("承認済みステータスの項目には承認ボタンを表示しない", async () => {
    vi.spyOn(client, "apiRequest").mockResolvedValue({
      items: [makeLottery({ id: 5, verificationStatus: "approved" })],
      total: 1,
    } satisfies LotteryListResponse);

    renderPage();
    const row = (await screen.findByText("商品5")).closest(".card")!;
    expect(within(row as HTMLElement).queryByRole("button", { name: "承認" })).not.toBeInTheDocument();
    expect(within(row as HTMLElement).getByRole("button", { name: "却下" })).toBeInTheDocument();
  });

  it("sourcePostPublishedAtがあれば「X投稿日時」を表示する", async () => {
    vi.spyOn(client, "apiRequest").mockResolvedValue({
      items: [makeLottery({ id: 11, sourcePostPublishedAt: "2026-08-11T06:15:24.000Z" })],
      total: 1,
    } satisfies LotteryListResponse);

    renderPage();

    expect(await screen.findByText(/X投稿日時: 2026\/08\/11/)).toBeInTheDocument();
  });

  it("sourcePostPublishedAtが無ければ「X投稿日時」を表示しない", async () => {
    vi.spyOn(client, "apiRequest").mockResolvedValue({
      items: [makeLottery({ id: 12, sourcePostPublishedAt: null })],
      total: 1,
    } satisfies LotteryListResponse);

    renderPage();
    await screen.findByText("商品12");

    expect(screen.queryByText(/X投稿日時/)).not.toBeInTheDocument();
  });

  describe("応募締切の表示と終了済みバッジ", () => {
    beforeEach(() => {
      vi.spyOn(Date, "now").mockReturnValue(new Date("2026-08-13T12:00:00.000Z").getTime());
    });

    it("applicationEndAtがあれば「締切」を表示する", async () => {
      vi.spyOn(client, "apiRequest").mockResolvedValue({
        items: [makeLottery({ id: 21, applicationEndAt: "2026-08-20T14:59:00.000Z" })],
        total: 1,
      } satisfies LotteryListResponse);

      renderPage();

      expect(await screen.findByText(/締切: 2026\/08\/20/)).toBeInTheDocument();
    });

    it("applicationEndAtが無くapplicationEndDateのみあれば日付のみの「締切」を表示する", async () => {
      vi.spyOn(client, "apiRequest").mockResolvedValue({
        items: [makeLottery({ id: 22, applicationEndDate: "2026-08-20" })],
        total: 1,
      } satisfies LotteryListResponse);

      renderPage();

      expect(await screen.findByText("締切: 2026/08/20")).toBeInTheDocument();
    });

    it("締切日時ともに未設定なら「締切」を表示しない", async () => {
      vi.spyOn(client, "apiRequest").mockResolvedValue({
        items: [makeLottery({ id: 23 })],
        total: 1,
      } satisfies LotteryListResponse);

      renderPage();
      await screen.findByText("商品23");

      expect(screen.queryByText(/締切:/)).not.toBeInTheDocument();
    });

    it("締切を過ぎていれば「終了済み」バッジを表示する", async () => {
      vi.spyOn(client, "apiRequest").mockResolvedValue({
        items: [makeLottery({ id: 24, applicationEndAt: "2026-08-01T14:59:00.000Z" })],
        total: 1,
      } satisfies LotteryListResponse);

      renderPage();

      expect(await screen.findByText("終了済み")).toBeInTheDocument();
    });

    it("締切前なら「終了済み」バッジを表示しない", async () => {
      vi.spyOn(client, "apiRequest").mockResolvedValue({
        items: [makeLottery({ id: 25, applicationEndAt: "2026-08-20T14:59:00.000Z" })],
        total: 1,
      } satisfies LotteryListResponse);

      renderPage();
      await screen.findByText("商品25");

      expect(screen.queryByText("終了済み")).not.toBeInTheDocument();
    });

    it("日付のみの締切は、当日23:59 JSTまでは終了済み扱いにしない（翌日0:00 JSTから終了済み）", async () => {
      // システム時刻を2026-08-13T12:00:00Z（=JST 21:00）に固定。
      // applicationEndDate=2026-08-13なら、JSTの日付境界（翌日0:00 JST = 2026-08-13T15:00:00Z）
      // より前なのでまだ終了済みではない。
      vi.spyOn(client, "apiRequest").mockResolvedValue({
        items: [makeLottery({ id: 26, applicationEndDate: "2026-08-13" })],
        total: 1,
      } satisfies LotteryListResponse);

      renderPage();
      await screen.findByText("商品26");

      expect(screen.queryByText("終了済み")).not.toBeInTheDocument();
    });
  });

  describe("X投稿日の範囲フィルタ", () => {
    it("開始日を指定すると、sourcePostPublishedAtFromを付けて再取得しページも0に戻る", async () => {
      const apiRequestSpy = vi
        .spyOn(client, "apiRequest")
        .mockResolvedValue({ items: [], total: 0 } satisfies LotteryListResponse);

      renderPage();
      await waitFor(() => expect(apiRequestSpy).toHaveBeenCalledTimes(1));

      fireEvent.change(screen.getByLabelText("X投稿日（開始）"), { target: { value: "2026-08-01" } });

      await waitFor(() => {
        const lastCall = apiRequestSpy.mock.calls.at(-1)?.[0] as string;
        expect(lastCall).toContain("sourcePostPublishedAtFrom=");
        expect(lastCall).toContain("offset=0");
      });
    });

    it("終了日を指定すると、sourcePostPublishedAtToを付けて再取得する", async () => {
      const apiRequestSpy = vi
        .spyOn(client, "apiRequest")
        .mockResolvedValue({ items: [], total: 0 } satisfies LotteryListResponse);

      renderPage();
      await waitFor(() => expect(apiRequestSpy).toHaveBeenCalledTimes(1));

      fireEvent.change(screen.getByLabelText("X投稿日（終了）"), { target: { value: "2026-08-10" } });

      await waitFor(() => {
        const lastCall = apiRequestSpy.mock.calls.at(-1)?.[0] as string;
        expect(lastCall).toContain("sourcePostPublishedAtTo=");
      });
    });

    it("開始日・終了日のどちらも未指定なら「クリア」ボタンを表示しない", async () => {
      vi.spyOn(client, "apiRequest").mockResolvedValue({ items: [], total: 0 } satisfies LotteryListResponse);

      renderPage();

      expect(screen.queryByRole("button", { name: "クリア" })).not.toBeInTheDocument();
    });

    it("「クリア」ボタンで日付フィルタを解除し、パラメータ無しで再取得する", async () => {
      const apiRequestSpy = vi
        .spyOn(client, "apiRequest")
        .mockResolvedValue({ items: [], total: 0 } satisfies LotteryListResponse);

      renderPage();
      await waitFor(() => expect(apiRequestSpy).toHaveBeenCalledTimes(1));

      fireEvent.change(screen.getByLabelText("X投稿日（開始）"), { target: { value: "2026-08-01" } });
      await waitFor(() => expect(screen.getByRole("button", { name: "クリア" })).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: "クリア" }));

      await waitFor(() => {
        const lastCall = apiRequestSpy.mock.calls.at(-1)?.[0] as string;
        expect(lastCall).not.toContain("sourcePostPublishedAtFrom");
        expect(lastCall).not.toContain("sourcePostPublishedAtTo");
      });
      expect(screen.queryByRole("button", { name: "クリア" })).not.toBeInTheDocument();
    });
  });

  it("取得に失敗するとエラーメッセージを表示する", async () => {
    vi.spyOn(client, "apiRequest").mockRejectedValue(new client.ApiError("SERVICE_BUSY", "サーバーが混雑しています", 503));

    renderPage();

    expect(await screen.findByText("サーバーが混雑しています")).toBeInTheDocument();
  });
});
