import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { ExtractedLotteryData, LotteryUpdateCandidateListResponse, LotteryUpdateCandidateRow } from "../types";

type Tab = "pending" | "applied" | "registered_as_new" | "ignored";

const TABS: { key: Tab; label: string }[] = [
  { key: "pending", label: "未処理" },
  { key: "applied", label: "反映済み" },
  { key: "registered_as_new", label: "新規登録済み" },
  { key: "ignored", label: "無視済み" },
];

const PAGE_SIZE = 20;

/** 旧80/50点マージ/レビュー閾値をUI表示ラベルとしてのみ流用する（自動書き込みには一切使わない）。 */
function matchLevelLabel(score: string | null): string {
  const n = Number(score ?? "0");
  if (n >= 80) return "高一致";
  if (n >= 50) return "要確認";
  return "低一致";
}

function parseExtracted(row: LotteryUpdateCandidateRow): ExtractedLotteryData | null {
  try {
    return JSON.parse(row.extractedData) as ExtractedLotteryData;
  } catch {
    return null;
  }
}

export function LotteryUpdateCandidateListPage() {
  const { admin, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("pending");
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<LotteryUpdateCandidateRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("status", tab);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      const res = await apiRequest<LotteryUpdateCandidateListResponse>(`/admin/lottery-update-candidates?${params.toString()}`);
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

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min(total, (page + 1) * PAGE_SIZE);

  return (
    <div className="page">
      <div className="header-row">
        <h1>更新候補</h1>
        <div className="header-right">
          <div className="nav-links">
            <span className="muted">{admin?.email}</span>
            <Link to="/">抽選一覧へ</Link>
            <button type="button" className="secondary" onClick={logout}>
              ログアウト
            </button>
          </div>
        </div>
      </div>

      <p className="muted" style={{ marginBottom: 16 }}>
        後続投稿が既存抽選を更新しうる候補です。既存抽選への反映は、ここで管理者が選択した内容のみが書き込まれます（自動更新はされません）。
      </p>

      <div className="filter-tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={tab === t.key ? "active" : ""} onClick={() => selectTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? <p className="muted">読み込み中…</p> : null}
      {error ? <p className="error-text">{error}</p> : null}
      {!loading && items.length === 0 ? <p className="muted">該当する更新候補はありません</p> : null}

      <p className="muted" style={{ marginBottom: 10 }}>
        {total.toLocaleString()}件中 {rangeStart}〜{rangeEnd}件目
      </p>

      <div className="lottery-list">
        {items.map((item) => {
          const extracted = parseExtracted(item);
          return (
            <Link key={item.id} to={`/update-candidates/${item.id}`} style={{ textDecoration: "none", color: "inherit" }}>
              <div className="card lottery-row">
                <div className="lottery-info">
                  <div className="title">
                    {extracted?.productNameRaw?.trim() || extracted?.normalizedProductName?.trim() || "商品名未確認"}
                  </div>
                  <div className="muted">
                    {extracted?.storeNameRaw?.trim() || extracted?.normalizedStoreName?.trim() || "店舗情報なし"}
                  </div>
                  <span className="badge needs-review">{matchLevelLabel(item.matchScore)}（{item.matchScore ?? 0}点）</span>
                </div>
              </div>
            </Link>
          );
        })}
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
