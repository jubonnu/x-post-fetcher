import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type {
  AutoResolveCandidateResult,
  ExtractedLotteryData,
  LotteryUpdateCandidateListResponse,
  LotteryUpdateCandidateRow,
} from "../types";

const AUTO_RESOLVE_REASON_LABEL: Record<string, string> = {
  target_lottery_not_found: "反映先の抽選が見つからない",
  has_conflicting_fields: "既存データと矛盾する項目がある（要確認）",
  no_changes: "既存データと完全一致（変更不要）",
  addable_only: "既存の空欄を埋めるだけ（安全）",
  claude_sourced_overwrite: "Claude in Chrome由来のため上書き反映",
  overwrite_requires_claude_source: "既存値の上書きが必要だが自動化対象外（要確認）",
};

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

/** 元投稿がXに投稿された日時を表示用に整形する（実際のX投稿と突き合わせて確認するため）。 */
function displayPublishedAt(item: LotteryUpdateCandidateRow): string | null {
  if (!item.sourcePostPublishedAt) return null;
  const d = new Date(item.sourcePostPublishedAt);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `X投稿日時: ${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

  // --- 自動判定（更新候補のみ対象。「要確認」は比較対象が無いため対象外） ---
  const [autoResolving, setAutoResolving] = useState(false);
  const [autoResolveError, setAutoResolveError] = useState<string | null>(null);
  const [autoResolvePreview, setAutoResolvePreview] = useState<AutoResolveCandidateResult[] | null>(null);
  const [autoResolveApplied, setAutoResolveApplied] = useState<AutoResolveCandidateResult[] | null>(null);

  /**
   * pendingの更新候補を最大100件取得し、1件ずつ`auto-resolve`を呼ぶ（まとめて処理すると
   * Cloudflare Workersの1リクエストあたりサブリクエスト数上限に達するため。Claude投入機能で
   * 実際に発生した障害と同じ理由で、ここでも1件ずつ順番に呼ぶ設計にしている）。
   */
  async function runAutoResolve(dryRun: boolean): Promise<AutoResolveCandidateResult[]> {
    const listRes = await apiRequest<LotteryUpdateCandidateListResponse>(
      "/admin/lottery-update-candidates?status=pending&limit=100"
    );
    const results: AutoResolveCandidateResult[] = [];
    for (const item of listRes.items) {
      const res = await apiRequest<AutoResolveCandidateResult>(`/admin/lottery-update-candidates/${item.id}/auto-resolve`, {
        method: "POST",
        body: { dryRun },
      });
      results.push(res);
      if (dryRun) setAutoResolvePreview([...results]);
      else setAutoResolveApplied([...results]);
    }
    return results;
  }

  async function handleAutoResolvePreview() {
    setAutoResolving(true);
    setAutoResolveError(null);
    setAutoResolveApplied(null);
    setAutoResolvePreview([]);
    try {
      await runAutoResolve(true);
    } catch (e) {
      setAutoResolveError(e instanceof ApiError ? e.message : "プレビューに失敗しました");
      setAutoResolvePreview(null);
    } finally {
      setAutoResolving(false);
    }
  }

  async function handleAutoResolveExecute() {
    if (!window.confirm("プレビュー内容で自動判定を実行します。反映・無視されたデータは通常の操作と同様、後から個別に確認できます。よろしいですか？")) {
      return;
    }
    setAutoResolving(true);
    setAutoResolveError(null);
    setAutoResolveApplied([]);
    try {
      await runAutoResolve(false);
      setAutoResolvePreview(null);
      await load();
    } catch (e) {
      setAutoResolveError(e instanceof ApiError ? e.message : "自動判定の実行に失敗しました");
    } finally {
      setAutoResolving(false);
    }
  }

  function summarize(results: AutoResolveCandidateResult[]) {
    return {
      apply: results.filter((r) => r.decision.action === "apply").length,
      ignore: results.filter((r) => r.decision.action === "ignore").length,
      skip: results.filter((r) => r.decision.action === "skip").length,
    };
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

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>未処理の更新候補を自動判定</h2>
        <p className="muted">
          既存が空欄の項目を埋めるだけ（安全）の候補や、既存データと完全一致する候補は自動で処理できます。
          既存値の上書きが必要な候補は、Claude in Chrome由来のデータのみ自動反映し、それ以外・矛盾する項目がある候補は
          「未処理」のまま残ります（人間の確認用）。
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" className="secondary" disabled={autoResolving} onClick={() => void handleAutoResolvePreview()}>
            {autoResolving && !autoResolveApplied ? "判定中…" : "プレビュー（dry run）"}
          </button>
          {autoResolvePreview && !autoResolveApplied ? (
            <button type="button" className="primary" disabled={autoResolving} onClick={() => void handleAutoResolveExecute()}>
              {autoResolving ? "実行中…" : "この内容で実行"}
            </button>
          ) : null}
        </div>
        {autoResolveError ? <p className="error-text">{autoResolveError}</p> : null}

        {autoResolvePreview && !autoResolveApplied ? (
          <div style={{ marginTop: 10 }}>
            <p className="muted">
              対象{autoResolvePreview.length}件中: 反映{summarize(autoResolvePreview).apply}件 / 無視(変更不要)
              {summarize(autoResolvePreview).ignore}件 / 未処理のまま{summarize(autoResolvePreview).skip}件
            </p>
            <AutoResolveResultTable results={autoResolvePreview} />
          </div>
        ) : null}

        {autoResolveApplied ? (
          <div style={{ marginTop: 10 }}>
            <p className="muted">
              実行結果: 対象{autoResolveApplied.length}件中 反映{summarize(autoResolveApplied).apply}件 / 無視(変更不要)
              {summarize(autoResolveApplied).ignore}件 / 未処理のまま{summarize(autoResolveApplied).skip}件
            </p>
            <AutoResolveResultTable results={autoResolveApplied} />
          </div>
        ) : null}
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
                  {displayPublishedAt(item) ? <div className="muted">{displayPublishedAt(item)}</div> : null}
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

function AutoResolveResultTable({ results }: { results: AutoResolveCandidateResult[] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th style={{ padding: "4px 8px" }}>候補ID</th>
            <th style={{ padding: "4px 8px" }}>判定</th>
            <th style={{ padding: "4px 8px" }}>理由</th>
            <th style={{ padding: "4px 8px" }}>対象フィールド</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.candidateId} style={{ borderBottom: "1px solid #f0f0f0" }}>
              <td style={{ padding: "4px 8px" }}>
                <Link to={`/update-candidates/${r.candidateId}`}>#{r.candidateId}</Link>
              </td>
              <td style={{ padding: "4px 8px" }}>
                {r.decision.action === "apply" ? "反映" : r.decision.action === "ignore" ? "無視(変更不要)" : "未処理のまま"}
              </td>
              <td style={{ padding: "4px 8px" }}>{AUTO_RESOLVE_REASON_LABEL[r.decision.reason] ?? r.decision.reason}</td>
              <td style={{ padding: "4px 8px" }}>{r.decision.fields.join(", ") || "―"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
