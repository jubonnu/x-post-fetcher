import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiRequest, ApiError } from "../api/client";
import type { FieldChange, LotteryUpdateCandidateDetailResponse } from "../types";

const FIELD_LABELS: Record<string, string> = {
  productNameRaw: "商品名",
  normalizedProductName: "商品名（正規化）",
  storeNameRaw: "店舗名",
  normalizedStoreName: "店舗名（正規化）",
  storeBranchRaw: "支店",
  normalizedStoreBranch: "支店（正規化）",
  region: "地域",
  applicationStartAt: "応募開始",
  confirmedOpenAt: "開催確定日時",
  applicationEndDate: "応募締切",
  resultAnnouncementStartAt: "当選発表開始",
  resultAnnouncementDate: "当選発表",
  purchaseStartAt: "購入開始",
  purchaseDeadlineAt: "購入期限",
  applicationUrl: "応募URL",
  officialInformationUrl: "公式情報URL",
  appDownloadUrl: "アプリDL URL",
  applicationMethod: "応募方法",
  eligibilityConditions: "応募条件",
  pickupMethod: "受取方法",
  paymentMethod: "支払方法",
  price: "価格",
};

function fieldLabel(fieldName: string): string {
  return FIELD_LABELS[fieldName] ?? fieldName;
}

function displayValue(v: string | null): string {
  return v && v.trim().length > 0 ? v : "（未設定）";
}

function matchLevelLabel(score: string | null): string {
  const n = Number(score ?? "0");
  if (n >= 80) return "高一致";
  if (n >= 50) return "要確認";
  return "低一致";
}

function formatPostDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function LotteryUpdateCandidateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<LotteryUpdateCandidateDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<LotteryUpdateCandidateDetailResponse>(`/admin/lottery-update-candidates/${id}`);
      setDetail(res);
      // 追加可能（既存が空欄）フィールドのみ既定でチェック済みにする。上書き・競合は
      // 管理者の明示的な選択を必須にする（誤った上書きを防ぐため既定は未選択）。
      setSelected(new Set(res.addableFields.map((f) => f.fieldName)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(fieldName: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fieldName)) next.delete(fieldName);
      else next.add(fieldName);
      return next;
    });
  }

  async function handleApply() {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/admin/lottery-update-candidates/${id}/apply`, {
        method: "POST",
        body: { fields: Array.from(selected) },
      });
      navigate("/update-candidates");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "反映に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function handleRegisterAsNew() {
    if (!window.confirm("既存抽選とは別に、新しい抽選として登録します。よろしいですか？")) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/admin/lottery-update-candidates/${id}/register-as-new`, { method: "POST" });
      navigate("/update-candidates");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "新規登録に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function handleIgnore() {
    if (!window.confirm("この更新候補を無視します。既存抽選には一切反映されません。よろしいですか？")) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/admin/lottery-update-candidates/${id}/ignore`, { method: "POST" });
      navigate("/update-candidates");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "無視の処理に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="page">読み込み中…</div>;
  if (error && !detail) return <div className="page error-text">{error}</div>;
  if (!detail) return null;

  const { candidate, targetLottery, addableFields, overwritableFields, conflictingFields, matchingFields, newSourcePost, existingSourcePost } =
    detail;
  const isResolved = candidate.status !== "pending";

  function renderFieldRow(change: FieldChange, kind: "addable" | "overwritable" | "conflicting") {
    return (
      <div key={`${kind}-${change.fieldName}`} className="card" style={{ padding: 12, marginBottom: 8 }}>
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: isResolved ? "default" : "pointer" }}>
          <input
            type="checkbox"
            checked={selected.has(change.fieldName)}
            disabled={isResolved}
            onChange={() => toggle(change.fieldName)}
            style={{ marginTop: 3 }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>
              {fieldLabel(change.fieldName)}
              {kind === "addable" ? <span className="badge approved" style={{ marginLeft: 8 }}>追加可能</span> : null}
              {kind === "overwritable" ? <span className="badge needs-review" style={{ marginLeft: 8 }}>上書き</span> : null}
              {kind === "conflicting" ? <span className="badge rejected" style={{ marginLeft: 8 }}>競合</span> : null}
            </div>
            <div className="muted" style={{ marginTop: 4 }}>
              既存: {displayValue(change.oldValue)}
            </div>
            <div className="muted">新規: {displayValue(change.newValue)}</div>
          </div>
        </label>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="header-row">
        <h1>更新候補の詳細</h1>
        <Link to="/update-candidates">一覧へ戻る</Link>
      </div>

      {error ? <p className="error-text">{error}</p> : null}

      <div className="card" style={{ marginBottom: 16 }}>
        <span className="badge needs-review">{matchLevelLabel(candidate.matchScore)}（{candidate.matchScore ?? 0}点）</span>
        <span className="muted" style={{ marginLeft: 10 }}>判定理由: {candidate.matchReason ?? "-"}</span>
        {isResolved ? (
          <p className="muted" style={{ marginTop: 8 }}>
            この候補は既に処理済みです（{candidate.status} / {candidate.resolvedBy ?? "-"}）。
          </p>
        ) : null}
        <div className="source-links-row">
          {existingSourcePost ? (
            <a href={existingSourcePost.sourceUrl ?? "#"} target="_blank" rel="noreferrer">
              既存抽選の元投稿を見る（{formatPostDate(existingSourcePost.publishedAt)}）
            </a>
          ) : (
            <span className="muted">既存抽選の元投稿情報なし</span>
          )}
          {newSourcePost ? (
            <a href={newSourcePost.sourceUrl ?? "#"} target="_blank" rel="noreferrer">
              新しい投稿を見る（{formatPostDate(newSourcePost.publishedAt)}）
            </a>
          ) : (
            <span className="muted">新しい投稿情報なし</span>
          )}
        </div>
      </div>

      {!targetLottery ? (
        <p className="error-text">反映先の既存抽選が見つかりません（削除・統合済みの可能性があります）。「別抽選として新規登録」のみ選択できます。</p>
      ) : (
        <>
          <h2>反映先の抽選</h2>
          <p className="muted" style={{ marginBottom: 16 }}>
            {targetLottery.productNameRaw ?? targetLottery.normalizedProductName ?? "商品名未確認"} /{" "}
            {targetLottery.storeNameRaw ?? targetLottery.normalizedStoreName ?? "店舗情報なし"}
          </p>

          {addableFields.length === 0 && overwritableFields.length === 0 && conflictingFields.length === 0 ? (
            <p className="muted">既存抽選と新しい抽出データの間に、反映可能な差分はありません。</p>
          ) : (
            <>
              {addableFields.length > 0 ? (
                <>
                  <h2>追加可能なフィールド（既存が未設定）</h2>
                  {addableFields.map((c) => renderFieldRow(c, "addable"))}
                </>
              ) : null}
              {overwritableFields.length > 0 ? (
                <>
                  <h2>上書きになるフィールド（既存の値を置き換えます）</h2>
                  {overwritableFields.map((c) => renderFieldRow(c, "overwritable"))}
                </>
              ) : null}
              {conflictingFields.length > 0 ? (
                <>
                  <h2>競合しているフィールド（既存と新規で値が異なります）</h2>
                  {conflictingFields.map((c) => renderFieldRow(c, "conflicting"))}
                </>
              ) : null}
            </>
          )}

          {matchingFields.length > 0 ? (
            <>
              <h2>一致しているフィールド</h2>
              <p className="muted" style={{ marginBottom: 16 }}>
                {matchingFields.map((f) => fieldLabel(f)).join(" / ")}
              </p>
            </>
          ) : null}
        </>
      )}

      {!isResolved ? (
        <div className="lottery-actions" style={{ marginTop: 24 }}>
          {targetLottery ? (
            <button type="button" className="primary" disabled={busy || selected.size === 0} onClick={handleApply}>
              選択したフィールドを既存抽選へ反映
            </button>
          ) : null}
          <button type="button" className="secondary" disabled={busy} onClick={handleRegisterAsNew}>
            別抽選として新規登録
          </button>
          <button type="button" className="danger" disabled={busy} onClick={handleIgnore}>
            無視する
          </button>
        </div>
      ) : null}
    </div>
  );
}
