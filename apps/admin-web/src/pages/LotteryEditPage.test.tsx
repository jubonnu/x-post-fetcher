import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LotteryEditPage } from "./LotteryEditPage";
import * as client from "../api/client";
import type { LotteryDetailResponse, LotteryListResponse, LotteryRow } from "../types";

function makeLottery(overrides: Partial<LotteryRow> = {}): LotteryRow {
  return {
    id: 42,
    productNameRaw: "テスト商品",
    normalizedProductName: null,
    storeNameRaw: "テスト店舗",
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

function renderEditPage(id = "42") {
  // "戻る"はブラウザ履歴を1つ戻る実装のため、一覧("/")を経由してから遷移してきた状態を再現する
  // （historyが無いとnavigate(-1)が何もしない）。
  return render(
    <MemoryRouter initialEntries={["/", `/lotteries/${id}`]} initialIndex={1}>
      <Routes>
        <Route path="/lotteries/:id" element={<LotteryEditPage />} />
        <Route path="/" element={<div>一覧画面</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("LotteryEditPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("読み込み後、既存の値がフォームに反映される", async () => {
    vi.spyOn(client, "apiRequest").mockResolvedValue({
      lottery: makeLottery(),
      sources: [],
      fieldHistory: [],
    } satisfies LotteryDetailResponse);

    renderEditPage();

    expect(await screen.findByDisplayValue("テスト商品")).toBeInTheDocument();
    expect(screen.getByDisplayValue("テスト店舗")).toBeInTheDocument();
  });

  it("保存すると入力内容をPATCHで送信し、成功メッセージを表示する", async () => {
    const apiRequestSpy = vi.spyOn(client, "apiRequest").mockImplementation(async (path, options) => {
      if (path === "/admin/lotteries/42" && options?.method === "PATCH") {
        return { lottery: makeLottery({ productNameRaw: "更新後タイトル" }), sources: [], fieldHistory: [] } satisfies LotteryDetailResponse;
      }
      if (path === "/admin/lotteries/42") {
        return { lottery: makeLottery(), sources: [], fieldHistory: [] } satisfies LotteryDetailResponse;
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderEditPage();
    await screen.findByDisplayValue("テスト商品");

    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "更新後タイトル" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(apiRequestSpy).toHaveBeenCalledWith(
        "/admin/lotteries/42",
        expect.objectContaining({
          method: "PATCH",
          body: expect.objectContaining({ productNameRaw: "更新後タイトル" }),
        })
      )
    );
    expect(await screen.findByText("保存しました")).toBeInTheDocument();
  });

  it("画像を選択するとアップロードされ、プレビューに反映される", async () => {
    vi.spyOn(client, "apiRequest").mockImplementation(async (path, options) => {
      if (path === "/admin/lotteries/42") {
        return { lottery: makeLottery(), sources: [], fieldHistory: [] } satisfies LotteryDetailResponse;
      }
      if (path === "/admin/lotteries/42/image") {
        expect(options?.rawContentType).toBe("image/png");
        return { imageUrl: "https://example.com/images/42-123.png" };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderEditPage();
    await screen.findByDisplayValue("テスト商品");

    const file = new File(["fake-bytes"], "photo.png", { type: "image/png" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      const img = document.querySelector(".image-upload-preview") as HTMLImageElement | null;
      expect(img?.src).toBe("https://example.com/images/42-123.png");
    });
  });

  it("画像削除ボタンで確認後にDELETEを呼び、プレビューが消える", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const apiRequestSpy = vi.spyOn(client, "apiRequest").mockImplementation(async (path, options) => {
      if (path === "/admin/lotteries/42" && !options) {
        return { lottery: makeLottery({ imageUrl: "https://example.com/images/42-123.png" }), sources: [], fieldHistory: [] } satisfies LotteryDetailResponse;
      }
      if (path === "/admin/lotteries/42/image" && options?.method === "DELETE") {
        return { ok: true };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderEditPage();
    await screen.findByDisplayValue("テスト商品");

    fireEvent.click(screen.getByRole("button", { name: "画像を削除" }));

    await waitFor(() => expect(apiRequestSpy).toHaveBeenCalledWith("/admin/lotteries/42/image", { method: "DELETE" }));
    await waitFor(() => expect(document.querySelector(".image-upload-preview")?.tagName).toBe("DIV"));
  });

  it("画像削除ボタンで確認をキャンセルするとDELETEを呼ばない", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const apiRequestSpy = vi.spyOn(client, "apiRequest").mockResolvedValue({
      lottery: makeLottery({ imageUrl: "https://example.com/images/42-123.png" }),
      sources: [],
      fieldHistory: [],
    } satisfies LotteryDetailResponse);

    renderEditPage();
    await screen.findByDisplayValue("テスト商品");

    fireEvent.click(screen.getByRole("button", { name: "画像を削除" }));

    expect(apiRequestSpy).not.toHaveBeenCalledWith("/admin/lotteries/42/image", expect.objectContaining({ method: "DELETE" }));
  });

  it("承認するボタンでPOST /admin/lotteries/:id/approveを呼び、一覧を再取得する", async () => {
    const apiRequestSpy = vi.spyOn(client, "apiRequest").mockResolvedValue({
      lottery: makeLottery(),
      sources: [],
      fieldHistory: [],
    } satisfies LotteryDetailResponse);

    renderEditPage();
    await screen.findByDisplayValue("テスト商品");

    fireEvent.click(screen.getByRole("button", { name: "承認する" }));

    await waitFor(() => expect(apiRequestSpy).toHaveBeenCalledWith("/admin/lotteries/42/approve", { method: "POST" }));
  });

  it("取得に失敗した場合はエラーメッセージを表示する", async () => {
    vi.spyOn(client, "apiRequest").mockRejectedValue(new client.ApiError("NOT_FOUND", "抽選が見つかりません", 404));

    renderEditPage();

    expect(await screen.findByText("抽選が見つかりません")).toBeInTheDocument();
  });

  it("重複統合の検索結果から統合先を選ぶと、確認後にmerge-intoを呼び一覧へ戻る", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const apiRequestSpy = vi.spyOn(client, "apiRequest").mockImplementation(async (path, options) => {
      if (path === "/admin/lotteries/42" && !options) {
        return { lottery: makeLottery(), sources: [], fieldHistory: [] } satisfies LotteryDetailResponse;
      }
      if (path === "/admin/lotteries?search=%E3%83%86%E3%82%B9%E3%83%88") {
        return {
          items: [makeLottery({ id: 99, productNameRaw: "統合先の商品" })],
          total: 1,
        } satisfies LotteryListResponse;
      }
      if (path === "/admin/lotteries/42/merge-into" && options?.method === "POST") {
        return { ok: true, targetId: 99, changedFields: [] };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderEditPage();
    await screen.findByDisplayValue("テスト商品");

    fireEvent.change(screen.getByPlaceholderText("統合先の商品名・店舗名で検索"), { target: { value: "テスト" } });
    fireEvent.click(screen.getByRole("button", { name: "検索" }));

    expect(await screen.findByText(/統合先の商品/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "この抽選に統合" }));

    await waitFor(() =>
      expect(apiRequestSpy).toHaveBeenCalledWith("/admin/lotteries/42/merge-into", {
        method: "POST",
        body: { targetId: 99 },
      })
    );
    expect(await screen.findByText("一覧画面")).toBeInTheDocument();
  });

  it("キャンセルボタンで一覧画面（/）へ戻る", async () => {
    vi.spyOn(client, "apiRequest").mockResolvedValue({
      lottery: makeLottery(),
      sources: [],
      fieldHistory: [],
    } satisfies LotteryDetailResponse);

    renderEditPage();
    await screen.findByDisplayValue("テスト商品");

    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(await screen.findByText("一覧画面")).toBeInTheDocument();
  });
});
