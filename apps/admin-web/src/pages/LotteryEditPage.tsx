import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiRequest, ApiError } from "../api/client";
import { VerificationBadge } from "../components/VerificationBadge";
import type { LotteryDetailResponse, LotteryRow } from "../types";
import { fromDatetimeLocalValue, toDatetimeLocalValue } from "../utils/datetime";

interface FormState {
  productNameRaw: string;
  storeNameRaw: string;
  applicationEndAt: string;
  resultAnnouncementAt: string;
  purchaseDeadlineAt: string;
  applicationMethod: string;
  applicationUrl: string;
}

function toFormState(lottery: LotteryRow): FormState {
  return {
    productNameRaw: lottery.productNameRaw ?? "",
    storeNameRaw: lottery.storeNameRaw ?? "",
    applicationEndAt: toDatetimeLocalValue(lottery.applicationEndAt),
    resultAnnouncementAt: toDatetimeLocalValue(lottery.resultAnnouncementAt),
    purchaseDeadlineAt: toDatetimeLocalValue(lottery.purchaseDeadlineAt),
    applicationMethod: lottery.applicationMethod ?? "",
    applicationUrl: lottery.applicationUrl ?? "",
  };
}

export function LotteryEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [lottery, setLottery] = useState<LotteryRow | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [deletingImage, setDeletingImage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<LotteryDetailResponse>(`/admin/lotteries/${id}`);
      setLottery(res.lottery);
      setForm(toFormState(res.lottery));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function updateField<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const res = await apiRequest<LotteryDetailResponse>(`/admin/lotteries/${id}`, {
        method: "PATCH",
        body: {
          productNameRaw: form.productNameRaw,
          storeNameRaw: form.storeNameRaw,
          applicationEndAt: fromDatetimeLocalValue(form.applicationEndAt),
          resultAnnouncementAt: fromDatetimeLocalValue(form.resultAnnouncementAt),
          purchaseDeadlineAt: fromDatetimeLocalValue(form.purchaseDeadlineAt),
          applicationMethod: form.applicationMethod,
          applicationUrl: form.applicationUrl,
        },
      });
      setLottery(res.lottery);
      setForm(toFormState(res.lottery));
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  async function handleImageSelected(file: File) {
    setUploadingImage(true);
    setError(null);
    try {
      const res = await apiRequest<{ imageUrl: string }>(`/admin/lotteries/${id}/image`, {
        method: "POST",
        rawBody: file,
        rawContentType: file.type,
      });
      setLottery((prev) => (prev ? { ...prev, imageUrl: res.imageUrl } : prev));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "画像のアップロードに失敗しました");
    } finally {
      setUploadingImage(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleImageDelete() {
    if (!window.confirm("画像を削除しますか？")) return;
    setDeletingImage(true);
    setError(null);
    try {
      await apiRequest(`/admin/lotteries/${id}/image`, { method: "DELETE" });
      setLottery((prev) => (prev ? { ...prev, imageUrl: null } : prev));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "画像の削除に失敗しました");
    } finally {
      setDeletingImage(false);
    }
  }

  async function handleApproveOrReject(action: "approve" | "reject") {
    if (action === "reject") {
      const reason = window.prompt("却下理由（任意）");
      if (reason === null) return;
      await apiRequest(`/admin/lotteries/${id}/reject`, { method: "POST", body: { reason: reason || null } });
    } else {
      await apiRequest(`/admin/lotteries/${id}/approve`, { method: "POST" });
    }
    await load();
  }

  if (loading) return <div className="page">読み込み中…</div>;
  if (!lottery || !form) return <div className="page error-text">{error ?? "抽選が見つかりません"}</div>;

  return (
    <div className="page">
      <div className="header-row">
        <h1>抽選編集</h1>
        <Link to="/">一覧へ戻る</Link>
      </div>

      <div className="card" style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 14 }}>
        <VerificationBadge status={lottery.verificationStatus} />
        {lottery.verificationStatus !== "approved" ? (
          <button type="button" className="primary" onClick={() => handleApproveOrReject("approve")}>
            承認する
          </button>
        ) : null}
        {lottery.verificationStatus !== "rejected" ? (
          <button type="button" className="danger" onClick={() => handleApproveOrReject("reject")}>
            却下する
          </button>
        ) : null}
        {lottery.rejectedReason ? <span className="muted">却下理由: {lottery.rejectedReason}</span> : null}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>商品画像</h2>
        {lottery.imageUrl ? <img src={lottery.imageUrl} alt="" className="image-upload-preview" /> : <div className="image-upload-preview" />}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={uploadingImage}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleImageSelected(file);
          }}
        />
        {uploadingImage ? <p className="muted">アップロード中…</p> : null}
        {lottery.imageUrl ? (
          <button type="button" className="danger" style={{ marginTop: 8 }} disabled={deletingImage} onClick={() => void handleImageDelete()}>
            {deletingImage ? "削除中…" : "画像を削除"}
          </button>
        ) : null}
      </div>

      <form className="card" onSubmit={handleSave}>
        <h2>抽選情報</h2>

        <div className="field">
          <label htmlFor="productNameRaw">タイトル</label>
          <input id="productNameRaw" type="text" value={form.productNameRaw} onChange={(e) => updateField("productNameRaw", e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="storeNameRaw">店舗</label>
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
          <input id="applicationMethod" type="text" value={form.applicationMethod} onChange={(e) => updateField("applicationMethod", e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="applicationUrl">応募ページ（URL）</label>
          <input id="applicationUrl" type="text" value={form.applicationUrl} onChange={(e) => updateField("applicationUrl", e.target.value)} />
        </div>

        {error ? <p className="error-text">{error}</p> : null}
        {savedAt ? <p className="muted">保存しました</p> : null}

        <button type="submit" className="primary" disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </button>
        <button type="button" className="secondary" style={{ marginLeft: 8 }} onClick={() => navigate("/")}>
          キャンセル
        </button>
      </form>
    </div>
  );
}
