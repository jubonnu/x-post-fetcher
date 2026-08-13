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

const PAGE_SIZE = 20;

function displayTitle(item: LotteryRow): string {
  return item.productNameRaw?.trim() || item.normalizedProductName?.trim() || "商品名未確認";
}

function displayStore(item: LotteryRow): string {
  return item.storeNameRaw?.trim() || item.normalizedStoreName?.trim() || "店舗情報なし";
}

/** 元投稿がXに投稿された日時を表示用に整形する（実際のX投稿と突き合わせて確認するため）。 */
function displayPublishedAt(item: LotteryRow): string | null {
  if (!item.sourcePostPublishedAt) return null;
  const d = new Date(item.sourcePostPublishedAt);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `X投稿日時: ${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 日付のみ（applicationEndDate）の値を、JSTの日付境界（翌日0:00 JSTからended）として
 * 解釈するためのオフセット（ミリ秒）。ワーカー側`endAtEpochExpr`・モバイル側`normalizeDeadline`と
 * 同一のルールであり、3者は必ず同期させること。
 */
const JST_DATE_ONLY_END_OF_DAY_OFFSET_MS = (24 - 9) * 60 * 60 * 1000;

/** 応募締切のエポックms（未設定ならnull）。atがあれば優先、無ければdateにJST日付境界を加算する。 */
function endAtMs(item: LotteryRow): number | null {
  if (item.applicationEndAt) {
    const t = new Date(item.applicationEndAt).getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (item.applicationEndDate) {
    const t = new Date(`${item.applicationEndDate}T00:00:00Z`).getTime();
    return Number.isNaN(t) ? null : t + JST_DATE_ONLY_END_OF_DAY_OFFSET_MS;
  }
  return null;
}

/** 応募締切を表示用に整形する（時刻まで確定していればat、日付のみならdateを表示）。 */
function displayDeadline(item: LotteryRow): string | null {
  if (item.applicationEndAt) {
    const d = new Date(item.applicationEndAt);
    if (Number.isNaN(d.getTime())) return null;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `締切: ${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (item.applicationEndDate) {
    return `締切: ${item.applicationEndDate.replaceAll("-", "/")}`;
  }
  return null;
}

/** 応募締切を過ぎているか（未設定なら判定不能としてfalse）。 */
function isEnded(item: LotteryRow): boolean {
  const ms = endAtMs(item);
  return ms !== null && ms < Date.now();
}

/** タブごとのサーバー側フィルタ条件をクエリ文字列へ変換する。 */
function filterQueryFor(tab: Tab): string {
  if (tab === "approved") return "verificationStatus=approved";
  if (tab === "rejected") return "verificationStatus=rejected";
  if (tab === "needsReview") return "excludeVerificationStatuses=approved,rejected";
  return "";
}

export function LotteryListPage() {
  const { admin, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("needsReview");
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<LotteryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const filterQuery = filterQueryFor(tab);
      const offset = page * PAGE_SIZE;
      const query = `?${filterQuery ? `${filterQuery}&` : ""}limit=${PAGE_SIZE}&offset=${offset}`;
      const res = await apiRequest<LotteryListResponse>(`/admin/lotteries${query}`);
      setItems(res.items);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "一覧の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [tab, page]);

  useEffect(() => {
    void load();
  }, [load]);

  function selectTab(next: Tab) {
    setTab(next);
    setPage(0);
  }

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

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min(total, (page + 1) * PAGE_SIZE);

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
          <button key={t.key} type="button" className={tab === t.key ? "active" : ""} onClick={() => selectTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? <p className="muted">読み込み中…</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      {!loading && items.length === 0 ? <p className="muted">該当する抽選はありません</p> : null}

      <p className="muted" style={{ marginBottom: 10 }}>
        {total.toLocaleString()}件中 {rangeStart}〜{rangeEnd}件目
      </p>

      <div className="lottery-list">
        {items.map((item) => (
          <div key={item.id} className="card lottery-row">
            {item.imageUrl ? <img src={item.imageUrl} alt="" className="lottery-thumb" /> : <div className="lottery-thumb" />}
            <div className="lottery-info">
              <div className="title">{displayTitle(item)}</div>
              <div className="muted">{displayStore(item)}</div>
              {displayPublishedAt(item) ? <div className="muted">{displayPublishedAt(item)}</div> : null}
              {displayDeadline(item) ? <div className="muted">{displayDeadline(item)}</div> : null}
              <VerificationBadge status={item.verificationStatus} />
              {isEnded(item) ? <span className="badge ended">終了済み</span> : null}
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

      {total > PAGE_SIZE ? (
        <div className="pagination-row">
          <button type="button" className="secondary" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            前へ
          </button>
          <span className="muted">
            {page + 1} / {pageCount}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          >
            次へ
          </button>
        </div>
      ) : null}
    </div>
  );
}
