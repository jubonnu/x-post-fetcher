import { useState, type FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import { apiRequest, ApiError } from "../api/client";
import type { LotteryDetailResponse } from "../types";
import { fromDatetimeLocalValue } from "../utils/datetime";

interface FormState {
  productNameRaw: string;
  storeNameRaw: string;
  applicationEndAt: string;
  resultAnnouncementAt: string;
  purchaseDeadlineAt: string;
  applicationMethod: string;
  applicationUrl: string;
}

const EMPTY_FORM: FormState = {
  productNameRaw: "",
  storeNameRaw: "",
  applicationEndAt: "",
  resultAnnouncementAt: "",
  purchaseDeadlineAt: "",
  applicationMethod: "",
  applicationUrl: "",
};

export function LotteryNewPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateField<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
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
          applicationEndAt: fromDatetimeLocalValue(form.applicationEndAt),
          resultAnnouncementAt: fromDatetimeLocalValue(form.resultAnnouncementAt),
          purchaseDeadlineAt: fromDatetimeLocalValue(form.purchaseDeadlineAt),
          applicationMethod: form.applicationMethod || null,
          applicationUrl: form.applicationUrl || null,
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
        <h1>抽選を手動で追加</h1>
        <Link to="/">一覧へ戻る</Link>
      </div>

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
          <label htmlFor="applicationEndAt">応募締切</label>
          <input
            id="applicationEndAt"
            type="datetime-local"
            value={form.applicationEndAt}
            onChange={(e) => updateField("applicationEndAt", e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="resultAnnouncementAt">当選発表</label>
          <input
            id="resultAnnouncementAt"
            type="datetime-local"
            value={form.resultAnnouncementAt}
            onChange={(e) => updateField("resultAnnouncementAt", e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="purchaseDeadlineAt">購入期限</label>
          <input
            id="purchaseDeadlineAt"
            type="datetime-local"
            value={form.purchaseDeadlineAt}
            onChange={(e) => updateField("purchaseDeadlineAt", e.target.value)}
          />
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
          <label htmlFor="applicationUrl">応募ページ（URL）</label>
          <input id="applicationUrl" type="text" value={form.applicationUrl} onChange={(e) => updateField("applicationUrl", e.target.value)} />
        </div>

        {error ? <p className="error-text">{error}</p> : null}

        <button type="submit" className="primary" disabled={saving}>
          {saving ? "作成中…" : "作成"}
        </button>
        <button type="button" className="secondary" style={{ marginLeft: 8 }} onClick={() => navigate("/")}>
          キャンセル
        </button>
      </form>
    </div>
  );
}
