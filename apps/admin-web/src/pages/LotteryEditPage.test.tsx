import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LotteryEditPage } from "./LotteryEditPage";
import * as client from "../api/client";
import type { LotteryDetailResponse, LotteryListResponse, LotteryRow } from "../types";
import { fromDatetimeLocalValue, toDatetimeLocalValue } from "../utils/datetime";

function makeLottery(overrides: Partial<LotteryRow> = {}): LotteryRow {
  return {
    id: 42,
    sourcePostId: null,
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
        <Route path="/lotteries/new" element={<DuplicateDestinationProbe />} />
        <Route path="/" element={<div>一覧画面</div>} />
      </Routes>
    </MemoryRouter>
  );
}

/** 「複製して新規作成」の遷移先で、渡されたlocation.stateの内容をテキストとして表示する（アサート用）。 */
function DuplicateDestinationProbe() {
  const location = useLocation();
  const state = location.state as {
    duplicateFrom?: { productNameRaw: string; storeNameRaw: string };
    duplicateSourcePostId?: number | null;
  } | null;
  return (
    <div>
      新規作成画面: {state?.duplicateFrom?.productNameRaw} / {state?.duplicateFrom?.storeNameRaw} / sourcePostId=
      {String(state?.duplicateSourcePostId)}
    </div>
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

  it("「複製して新規作成」で現在のフォーム内容とsourcePostId（X投稿日引き継ぎ用）を引き継いで新規作成画面へ遷移する", async () => {
    vi.spyOn(client, "apiRequest").mockResolvedValue({
      lottery: makeLottery({ productNameRaw: "複製元商品", storeNameRaw: "複製元店舗", sourcePostId: 777 }),
      sources: [],
      fieldHistory: [],
    } satisfies LotteryDetailResponse);

    renderEditPage();
    await screen.findByDisplayValue("複製元商品");

    fireEvent.click(screen.getByRole("button", { name: "複製して新規作成" }));

    expect(await screen.findByText("新規作成画面: 複製元商品 / 複製元店舗 / sourcePostId=777")).toBeInTheDocument();
  });

  it("複製元にsourcePostIdが無ければnullを引き継ぐ", async () => {
    vi.spyOn(client, "apiRequest").mockResolvedValue({
      lottery: makeLottery({ productNameRaw: "手動追加元商品", storeNameRaw: "手動追加元店舗", sourcePostId: null }),
      sources: [],
      fieldHistory: [],
    } satisfies LotteryDetailResponse);

    renderEditPage();
    await screen.findByDisplayValue("手動追加元商品");

    fireEvent.click(screen.getByRole("button", { name: "複製して新規作成" }));

    expect(await screen.findByText("新規作成画面: 手動追加元商品 / 手動追加元店舗 / sourcePostId=null")).toBeInTheDocument();
  });

  describe("応募ページURL（複数追加）", () => {
    it("既存のapplicationUrlsがあれば、その件数分の入力欄が表示される", async () => {
      vi.spyOn(client, "apiRequest").mockResolvedValue({
        lottery: makeLottery({ applicationUrls: ["https://example.com/a", "https://example.com/b"] }),
        sources: [],
        fieldHistory: [],
      } satisfies LotteryDetailResponse);

      renderEditPage();

      expect(await screen.findByDisplayValue("https://example.com/a")).toBeInTheDocument();
      expect(screen.getByDisplayValue("https://example.com/b")).toBeInTheDocument();
    });

    it("applicationUrlsが無くapplicationUrlのみあれば、1件だけ入力欄が表示される", async () => {
      vi.spyOn(client, "apiRequest").mockResolvedValue({
        lottery: makeLottery({ applicationUrl: "https://example.com/single", applicationUrls: null }),
        sources: [],
        fieldHistory: [],
      } satisfies LotteryDetailResponse);

      renderEditPage();

      expect(await screen.findByDisplayValue("https://example.com/single")).toBeInTheDocument();
      expect(screen.getAllByLabelText(/応募ページURL/)).toHaveLength(1);
    });

    it("「＋ URLを追加」で入力欄が増え、保存すると入力した全URLが配列で送信される", async () => {
      const apiRequestSpy = vi.spyOn(client, "apiRequest").mockImplementation(async (path, options) => {
        if (path === "/admin/lotteries/42" && options?.method === "PATCH") {
          return { lottery: makeLottery(), sources: [], fieldHistory: [] } satisfies LotteryDetailResponse;
        }
        if (path === "/admin/lotteries/42") {
          return { lottery: makeLottery(), sources: [], fieldHistory: [] } satisfies LotteryDetailResponse;
        }
        throw new Error(`unexpected path: ${path}`);
      });

      renderEditPage();
      await screen.findByDisplayValue("テスト商品");

      fireEvent.click(screen.getByRole("button", { name: "＋ URLを追加" }));
      fireEvent.change(screen.getByLabelText("応募ページURL 1"), { target: { value: "https://example.com/1" } });
      fireEvent.click(screen.getByRole("button", { name: "＋ URLを追加" }));
      fireEvent.change(screen.getByLabelText("応募ページURL 2"), { target: { value: "https://example.com/2" } });
      fireEvent.click(screen.getByRole("button", { name: "保存" }));

      await waitFor(() =>
        expect(apiRequestSpy).toHaveBeenCalledWith(
          "/admin/lotteries/42",
          expect.objectContaining({
            method: "PATCH",
            body: expect.objectContaining({ applicationUrls: ["https://example.com/1", "https://example.com/2"] }),
          })
        )
      );
    });

    it("「削除」ボタンでその行の入力欄が消え、保存内容にも含まれない", async () => {
      const apiRequestSpy = vi.spyOn(client, "apiRequest").mockImplementation(async (path, options) => {
        if (path === "/admin/lotteries/42" && options?.method === "PATCH") {
          return { lottery: makeLottery(), sources: [], fieldHistory: [] } satisfies LotteryDetailResponse;
        }
        return { lottery: makeLottery({ applicationUrls: ["https://example.com/a", "https://example.com/b"] }), sources: [], fieldHistory: [] } satisfies LotteryDetailResponse;
      });

      renderEditPage();
      await screen.findByDisplayValue("https://example.com/a");

      const deleteButtons = screen.getAllByRole("button", { name: "削除" });
      fireEvent.click(deleteButtons[0]);

      expect(screen.queryByDisplayValue("https://example.com/a")).not.toBeInTheDocument();
      expect(screen.getByDisplayValue("https://example.com/b")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "保存" }));

      await waitFor(() =>
        expect(apiRequestSpy).toHaveBeenCalledWith(
          "/admin/lotteries/42",
          expect.objectContaining({
            method: "PATCH",
            body: expect.objectContaining({ applicationUrls: ["https://example.com/b"] }),
          })
        )
      );
    });

    it("空欄の行は保存時に除外される", async () => {
      const apiRequestSpy = vi.spyOn(client, "apiRequest").mockResolvedValue({
        lottery: makeLottery(),
        sources: [],
        fieldHistory: [],
      } satisfies LotteryDetailResponse);

      renderEditPage();
      await screen.findByDisplayValue("テスト商品");

      fireEvent.click(screen.getByRole("button", { name: "＋ URLを追加" }));
      fireEvent.click(screen.getByRole("button", { name: "保存" }));

      await waitFor(() =>
        expect(apiRequestSpy).toHaveBeenCalledWith(
          "/admin/lotteries/42",
          expect.objectContaining({ method: "PATCH", body: expect.objectContaining({ applicationUrls: [] }) })
        )
      );
    });
  });

  describe("開始日〜終了日の表示・編集（Phase 10）", () => {
    it("既存の開始日時がフォームに反映される", async () => {
      const applicationStartAt = "2026-08-11T05:00:00.000Z";
      const resultAnnouncementStartAt = "2026-08-14T00:00:00.000Z";
      const purchaseStartAt = "2026-08-19T00:00:00.000Z";
      vi.spyOn(client, "apiRequest").mockResolvedValue({
        lottery: makeLottery({ applicationStartAt, resultAnnouncementStartAt, purchaseStartAt }),
        sources: [],
        fieldHistory: [],
      } satisfies LotteryDetailResponse);

      renderEditPage();
      await screen.findByDisplayValue("テスト商品");

      // 実行環境のローカルタイムゾーンに依存しないよう、コンポーネントと同じ変換関数で期待値を計算する
      expect((screen.getByLabelText("応募開始") as HTMLInputElement).value).toBe(toDatetimeLocalValue(applicationStartAt));
      expect((screen.getByLabelText("当選発表開始") as HTMLInputElement).value).toBe(toDatetimeLocalValue(resultAnnouncementStartAt));
      expect((screen.getByLabelText("購入開始") as HTMLInputElement).value).toBe(toDatetimeLocalValue(purchaseStartAt));
    });

    it("開始日を入力して保存すると、PATCHのbodyに開始日時系フィールドが含まれる", async () => {
      const apiRequestSpy = vi.spyOn(client, "apiRequest").mockImplementation(async (path, options) => {
        if (path === "/admin/lotteries/42" && options?.method === "PATCH") {
          return { lottery: makeLottery(), sources: [], fieldHistory: [] } satisfies LotteryDetailResponse;
        }
        return { lottery: makeLottery(), sources: [], fieldHistory: [] } satisfies LotteryDetailResponse;
      });

      // datetime-local入力欄への入力値（ローカル時刻表記）。実行環境のタイムゾーンに関わらず、
      // 期待値もfromDatetimeLocalValueで同じ変換を通すため一致する。
      const applicationStartLocal = "2026-08-11T14:00";
      const resultAnnouncementStartLocal = "2026-08-14T09:00";
      const purchaseStartLocal = "2026-08-19T09:00";

      renderEditPage();
      await screen.findByDisplayValue("テスト商品");

      fireEvent.change(screen.getByLabelText("応募開始"), { target: { value: applicationStartLocal } });
      fireEvent.change(screen.getByLabelText("当選発表開始"), { target: { value: resultAnnouncementStartLocal } });
      fireEvent.change(screen.getByLabelText("購入開始"), { target: { value: purchaseStartLocal } });
      fireEvent.click(screen.getByRole("button", { name: "保存" }));

      await waitFor(() =>
        expect(apiRequestSpy).toHaveBeenCalledWith(
          "/admin/lotteries/42",
          expect.objectContaining({
            method: "PATCH",
            body: expect.objectContaining({
              applicationStartAt: fromDatetimeLocalValue(applicationStartLocal),
              resultAnnouncementStartAt: fromDatetimeLocalValue(resultAnnouncementStartLocal),
              purchaseStartAt: fromDatetimeLocalValue(purchaseStartLocal),
            }),
          })
        )
      );
    });

    it("開始日が未設定の場合は空欄で表示される", async () => {
      vi.spyOn(client, "apiRequest").mockResolvedValue({
        lottery: makeLottery(),
        sources: [],
        fieldHistory: [],
      } satisfies LotteryDetailResponse);

      renderEditPage();
      await screen.findByDisplayValue("テスト商品");

      expect((screen.getByLabelText("応募開始") as HTMLInputElement).value).toBe("");
    });
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
