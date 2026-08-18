import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { apiRequest, ApiError } from "../api/client";
import { VerificationBadge } from "../components/VerificationBadge";
import type { LotteryDetailResponse, LotteryListResponse, LotteryRow } from "../types";
import type { LotteryFormState } from "./LotteryNewPage";
import { fromDatetimeLocalValue, toDatetimeLocalValue } from "../utils/datetime";

type FormState = LotteryFormState;

function toFormState(lottery: LotteryRow): FormState {
  const urls =
    lottery.applicationUrls && lottery.applicationUrls.length > 0
      ? lottery.applicationUrls
      : lottery.applicationUrl
        ? [lottery.applicationUrl]
        : [];
  return {
    productNameRaw: lottery.productNameRaw ?? "",
    storeNameRaw: lottery.storeNameRaw ?? "",
    applicationStartAt: toDatetimeLocalValue(lottery.applicationStartAt ?? null),
    applicationEndAt: toDatetimeLocalValue(lottery.applicationEndAt),
    resultAnnouncementStartAt: toDatetimeLocalValue(lottery.resultAnnouncementStartAt ?? null),
    resultAnnouncementAt: toDatetimeLocalValue(lottery.resultAnnouncementAt),
    purchaseStartAt: toDatetimeLocalValue(lottery.purchaseStartAt ?? null),
    purchaseDeadlineAt: toDatetimeLocalValue(lottery.purchaseDeadlineAt),
    applicationMethod: lottery.applicationMethod ?? "",
    applicationUrls: urls,
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
  const [mergeSearch, setMergeSearch] = useState("");
  const [mergeResults, setMergeResults] = useState<LotteryRow[] | null>(null);
  const [mergeSearching, setMergeSearching] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

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

  function updateField<K extends Exclude<keyof FormState, "applicationUrls">>(key: K, value: string) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function updateApplicationUrl(index: number, value: string) {
    setForm((prev) => (prev ? { ...prev, applicationUrls: prev.applicationUrls.map((u, i) => (i === index ? value : u)) } : prev));
  }

  function addApplicationUrl() {
    setForm((prev) => (prev ? { ...prev, applicationUrls: [...prev.applicationUrls, ""] } : prev));
  }

  function removeApplicationUrl(index: number) {
    setForm((prev) => (prev ? { ...prev, applicationUrls: prev.applicationUrls.filter((_, i) => i !== index) } : prev));
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
          applicationStartAt: fromDatetimeLocalValue(form.applicationStartAt),
          applicationEndAt: fromDatetimeLocalValue(form.applicationEndAt),
          resultAnnouncementStartAt: fromDatetimeLocalValue(form.resultAnnouncementStartAt),
          resultAnnouncementAt: fromDatetimeLocalValue(form.resultAnnouncementAt),
          purchaseStartAt: fromDatetimeLocalValue(form.purchaseStartAt),
          purchaseDeadlineAt: fromDatetimeLocalValue(form.purchaseDeadlineAt),
          applicationMethod: form.applicationMethod,
          applicationUrls: form.applicationUrls.map((u) => u.trim()).filter((u) => u.length > 0),
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

  async function handleMergeSearch(e: FormEvent) {
    e.preventDefault();
    if (!mergeSearch.trim()) return;
    setMergeSearching(true);
    setMergeError(null);
    try {
      const res = await apiRequest<LotteryListResponse>(`/admin/lotteries?search=${encodeURIComponent(mergeSearch.trim())}`);
      setMergeResults(res.items.filter((i) => String(i.id) !== id));
    } catch (e) {
      setMergeError(e instanceof ApiError ? e.message : "検索に失敗しました");
    } finally {
      setMergeSearching(false);
    }
  }

  async function handleMergeInto(targetId: number) {
    if (!window.confirm(`この抽選を #${targetId} に統合しますか？統合後、この抽選は一覧から表示されなくなります。`)) return;
    setMerging(true);
    setMergeError(null);
    try {
      await apiRequest(`/admin/lotteries/${id}/merge-into`, { method: "POST", body: { targetId } });
      navigate(-1);
    } catch (e) {
      setMergeError(e instanceof ApiError ? e.message : "統合に失敗しました");
    } finally {
      setMerging(false);
    }
  }

  /**
   * 現在フォームに入っている内容（未保存の編集も含む）を引き継いで新規作成画面へ遷移する。
   * 類似の抽選（別の日程・別枠等）をゼロから入力し直さず済むようにするため（画像は複製しない）。
   * `sourcePostId`（元のX投稿）も引き継ぎ、管理一覧の「X投稿日」がそのまま表示されるようにする
   * （1つの投稿に複数抽選が紐づくこと自体は複数抽選分割で元々起こりうるため問題ない）。
   */
  function handleDuplicate() {
    if (!form || !lottery) return;
    navigate("/lotteries/new", { state: { duplicateFrom: form, duplicateSourcePostId: lottery.sourcePostId } });
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
        {/* 一覧の絞り込み（タブ・X投稿日フィルタ等）を維持したまま戻るため、固定URLではなく
            ブラウザ履歴を1つ戻る（一覧から遷移してきた場合、直前のURLは常に一覧のURLになる）。 */}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="secondary" onClick={handleDuplicate}>
            複製して新規作成
          </button>
          <button type="button" className="secondary" onClick={() => navigate(-1)}>
            一覧へ戻る
          </button>
        </div>
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
        <h2>重複として統合</h2>
        <p className="muted">
          既に登録されている別の抽選と同じ内容の場合、ここで統合できます。統合するとこの抽選は一覧から消え、
          空欄だった項目は統合先へコピーされます。
        </p>
        <form onSubmit={handleMergeSearch} style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input
            type="text"
            placeholder="統合先の商品名・店舗名で検索"
            value={mergeSearch}
            onChange={(e) => setMergeSearch(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="submit" className="secondary" disabled={mergeSearching}>
            {mergeSearching ? "検索中…" : "検索"}
          </button>
        </form>

        {mergeError ? <p className="error-text">{mergeError}</p> : null}

        {mergeResults ? (
          mergeResults.length === 0 ? (
            <p className="muted">該当する抽選が見つかりませんでした</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, marginTop: 8 }}>
              {mergeResults.map((r) => (
                <li
                  key={r.id}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderTop: "1px solid #eee" }}
                >
                  <span>
                    #{r.id} {r.productNameRaw ?? "（商品名未設定）"} / {r.storeNameRaw ?? "（店舗名未設定）"}
                  </span>
                  <button type="button" className="primary" disabled={merging} onClick={() => void handleMergeInto(r.id)}>
                    この抽選に統合
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : null}
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
          <input id="applicationMethod" type="text" value={form.applicationMethod} onChange={(e) => updateField("applicationMethod", e.target.value)} />
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
        {savedAt ? <p className="muted">保存しました</p> : null}

        <button type="submit" className="primary" disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </button>
        <button type="button" className="secondary" style={{ marginLeft: 8 }} onClick={() => navigate(-1)}>
          キャンセル
        </button>
      </form>
    </div>
  );
}
