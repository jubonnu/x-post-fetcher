import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { apiRequest, ApiError } from "../api/client";
import type { LotteryDetailResponse } from "../types";
import { fromDatetimeLocalValue } from "../utils/datetime";

export interface LotteryFormState {
  productNameRaw: string;
  storeNameRaw: string;
  applicationStartAt: string;
  applicationEndAt: string;
  resultAnnouncementStartAt: string;
  resultAnnouncementAt: string;
  purchaseStartAt: string;
  purchaseDeadlineAt: string;
  applicationMethod: string;
  applicationUrls: string[];
}

const EMPTY_FORM: LotteryFormState = {
  productNameRaw: "",
  storeNameRaw: "",
  applicationStartAt: "",
  applicationEndAt: "",
  resultAnnouncementStartAt: "",
  resultAnnouncementAt: "",
  purchaseStartAt: "",
  purchaseDeadlineAt: "",
  applicationMethod: "",
  applicationUrls: [],
};

/** 抽選編集画面の「複製して新規作成」から渡される`location.state`の形。 */
interface DuplicateLocationState {
  duplicateFrom?: LotteryFormState;
  /** 複製元と同じ元投稿のID（管理一覧の「X投稿日」表示を引き継ぐため）。元投稿が無ければnull。 */
  duplicateSourcePostId?: number | null;
}

export function LotteryNewPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const duplicateState = location.state as DuplicateLocationState | null;
  const duplicateFrom = duplicateState?.duplicateFrom;
  const duplicateSourcePostId = duplicateState?.duplicateSourcePostId ?? null;
  const isDuplicate = Boolean(duplicateFrom);
  const [form, setForm] = useState<LotteryFormState>(() => (duplicateFrom ? { ...duplicateFrom } : EMPTY_FORM));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateField<K extends Exclude<keyof LotteryFormState, "applicationUrls">>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function updateApplicationUrl(index: number, value: string) {
    setForm((prev) => ({ ...prev, applicationUrls: prev.applicationUrls.map((u, i) => (i === index ? value : u)) }));
  }

  function addApplicationUrl() {
    setForm((prev) => ({ ...prev, applicationUrls: [...prev.applicationUrls, ""] }));
  }

  function removeApplicationUrl(index: number) {
    setForm((prev) => ({ ...prev, applicationUrls: prev.applicationUrls.filter((_, i) => i !== index) }));
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!form.productNameRaw.trim() || !form.storeNameRaw.trim()) {
      setError("タイトルと店舗は必須です");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiRequest<LotteryDetailResponse>("/admin/lotteries", {
        method: "POST",
        body: {
          productNameRaw: form.productNameRaw.trim(),
          storeNameRaw: form.storeNameRaw.trim(),
          applicationStartAt: fromDatetimeLocalValue(form.applicationStartAt),
          applicationEndAt: fromDatetimeLocalValue(form.applicationEndAt),
          resultAnnouncementStartAt: fromDatetimeLocalValue(form.resultAnnouncementStartAt),
          resultAnnouncementAt: fromDatetimeLocalValue(form.resultAnnouncementAt),
          purchaseStartAt: fromDatetimeLocalValue(form.purchaseStartAt),
          purchaseDeadlineAt: fromDatetimeLocalValue(form.purchaseDeadlineAt),
          applicationMethod: form.applicationMethod || null,
          applicationUrls: form.applicationUrls.map((u) => u.trim()).filter((u) => u.length > 0),
          ...(duplicateSourcePostId ? { sourcePostId: duplicateSourcePostId } : {}),
        },
      });
      // 作成後は編集画面へ遷移する（画像アップロード等はそちらで続けて行える）
      navigate(`/lotteries/${res.lottery.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "作成に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page">
      <div className="header-row">
        <h1>{isDuplicate ? "抽選を複製して新規作成" : "抽選を手動で追加"}</h1>
        {/* 一覧の絞り込み（タブ・X投稿日フィルタ等）を維持したまま戻るため、固定URLではなく
            ブラウザ履歴を1つ戻る。 */}
        <button type="button" className="secondary" onClick={() => navigate(-1)}>
          一覧へ戻る
        </button>
      </div>

      {isDuplicate ? (
        <p className="muted" style={{ marginBottom: 16 }}>
          複製元の内容を引き継いでいます。内容を確認・修正してから作成してください（画像は引き継がれません）。
        </p>
      ) : null}

      <form className="card" onSubmit={handleCreate}>
        <h2>抽選情報</h2>

        <div className="field">
          <label htmlFor="productNameRaw">タイトル *</label>
          <input
            id="productNameRaw"
            type="text"
            value={form.productNameRaw}
            onChange={(e) => updateField("productNameRaw", e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="storeNameRaw">店舗 *</label>
          <input id="storeNameRaw" type="text" value={form.storeNameRaw} onChange={(e) => updateField("storeNameRaw", e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="applicationEndAt">応募期間（開始 〜 締切）</label>
          <div className="datetime-range-row">
            <input
              id="applicationStartAt"
              type="datetime-local"
              aria-label="応募開始"
              value={form.applicationStartAt}
              onChange={(e) => updateField("applicationStartAt", e.target.value)}
            />
            <span className="muted">〜</span>
            <input
              id="applicationEndAt"
              type="datetime-local"
              aria-label="応募締切"
              value={form.applicationEndAt}
              onChange={(e) => updateField("applicationEndAt", e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="resultAnnouncementAt">当選発表（開始 〜 終了）</label>
          <div className="datetime-range-row">
            <input
              id="resultAnnouncementStartAt"
              type="datetime-local"
              aria-label="当選発表開始"
              value={form.resultAnnouncementStartAt}
              onChange={(e) => updateField("resultAnnouncementStartAt", e.target.value)}
            />
            <span className="muted">〜</span>
            <input
              id="resultAnnouncementAt"
              type="datetime-local"
              aria-label="当選発表"
              value={form.resultAnnouncementAt}
              onChange={(e) => updateField("resultAnnouncementAt", e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="purchaseDeadlineAt">購入期間（開始 〜 期限）</label>
          <div className="datetime-range-row">
            <input
              id="purchaseStartAt"
              type="datetime-local"
              aria-label="購入開始"
              value={form.purchaseStartAt}
              onChange={(e) => updateField("purchaseStartAt", e.target.value)}
            />
            <span className="muted">〜</span>
            <input
              id="purchaseDeadlineAt"
              type="datetime-local"
              aria-label="購入期限"
              value={form.purchaseDeadlineAt}
              onChange={(e) => updateField("purchaseDeadlineAt", e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="applicationMethod">応募方法</label>
          <input
            id="applicationMethod"
            type="text"
            value={form.applicationMethod}
            onChange={(e) => updateField("applicationMethod", e.target.value)}
          />
        </div>

        <div className="field">
          <label>応募ページ（URL）</label>
          {form.applicationUrls.map((url, index) => (
            <div key={index} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <input
                type="text"
                aria-label={`応募ページURL ${index + 1}`}
                value={url}
                onChange={(e) => updateApplicationUrl(index, e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="button" className="danger" onClick={() => removeApplicationUrl(index)}>
                削除
              </button>
            </div>
          ))}
          <button type="button" className="secondary" onClick={addApplicationUrl}>
            ＋ URLを追加
          </button>
        </div>

        {error ? <p className="error-text">{error}</p> : null}

        <button type="submit" className="primary" disabled={saving}>
          {saving ? "作成中…" : "作成"}
        </button>
        <button type="button" className="secondary" style={{ marginLeft: 8 }} onClick={() => navigate(-1)}>
          キャンセル
        </button>
      </form>
    </div>
  );
}
