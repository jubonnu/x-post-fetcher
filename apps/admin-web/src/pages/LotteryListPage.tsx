import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest, ApiError } from "../api/client";
import { VerificationBadge } from "../components/VerificationBadge";
import { useAuth } from "../auth/AuthContext";
import type { LotteryListResponse, LotteryRow } from "../types";

type Tab = "all" | "needsReview" | "approved" | "rejected";

const TABS: { key: Tab; label: string }[] = [
  { key: "needsReview", label: "要確認" },
  { key: "all", label: "すべて" },
  { key: "approved", label: "承認済み" },
  { key: "rejected", label: "却下済み" },
];

const LIST_LIMIT = 100;

function displayTitle(item: LotteryRow): string {
  return item.productNameRaw?.trim() || item.normalizedProductName?.trim() || "商品名未確認";
}

function displayStore(item: LotteryRow): string {
  return item.storeNameRaw?.trim() || item.normalizedStoreName?.trim() || "店舗情報なし";
}

export function LotteryListPage() {
  const { admin, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("needsReview");
  const [items, setItems] = useState<LotteryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = tab === "approved" ? "?verificationStatus=approved&limit=" + LIST_LIMIT : tab === "rejected" ? "?verificationStatus=rejected&limit=" + LIST_LIMIT : `?limit=${LIST_LIMIT}`;
      const res = await apiRequest<LotteryListResponse>(`/admin/lotteries${query}`);
      const filtered = tab === "needsReview" ? res.items.filter((i) => i.verificationStatus !== "approved" && i.verificationStatus !== "rejected") : res.items;
      setItems(filtered);
      setTotal(tab === "needsReview" ? filtered.length : res.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "一覧の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleApprove(id: number) {
    setBusyId(id);
    try {
      await apiRequest(`/admin/lotteries/${id}/approve`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "承認に失敗しました");
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(id: number) {
    const reason = window.prompt("却下理由（任意）");
    if (reason === null) return; // キャンセル
    setBusyId(id);
    try {
      await apiRequest(`/admin/lotteries/${id}/reject`, { method: "POST", body: { reason: reason || null } });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "却下に失敗しました");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page">
      <div className="header-row">
        <h1>抽選一覧</h1>
        <div className="nav-links">
          <span className="muted">{admin?.email}</span>
          <Link to="/change-password">パスワード変更</Link>
          <button type="button" className="secondary" onClick={logout}>
            ログアウト
          </button>
        </div>
      </div>

      <div className="filter-tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? <p className="muted">読み込み中…</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      {!loading && items.length === 0 ? <p className="muted">該当する抽選はありません</p> : null}

      <p className="muted" style={{ marginBottom: 10 }}>
        {total.toLocaleString()}件{total >= LIST_LIMIT ? `（最大${LIST_LIMIT}件まで表示）` : ""}
      </p>

      <div className="lottery-list">
        {items.map((item) => (
          <div key={item.id} className="card lottery-row">
            {item.imageUrl ? <img src={item.imageUrl} alt="" className="lottery-thumb" /> : <div className="lottery-thumb" />}
            <div className="lottery-info">
              <div className="title">{displayTitle(item)}</div>
              <div className="muted">{displayStore(item)}</div>
              <VerificationBadge status={item.verificationStatus} />
            </div>
            <div className="lottery-actions">
              <Link to={`/lotteries/${item.id}`}>
                <button type="button" className="secondary">
                  編集
                </button>
              </Link>
              {item.verificationStatus !== "approved" ? (
                <button type="button" className="primary" disabled={busyId === item.id} onClick={() => handleApprove(item.id)}>
                  承認
                </button>
              ) : null}
              {item.verificationStatus !== "rejected" ? (
                <button type="button" className="danger" disabled={busyId === item.id} onClick={() => handleReject(item.id)}>
                  却下
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
