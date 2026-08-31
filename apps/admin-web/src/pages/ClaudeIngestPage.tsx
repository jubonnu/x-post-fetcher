import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ClaudePostInputSchema, type ClaudePostInput } from "@x-post/shared";
import { apiRequest, ApiError } from "../api/client";
import type { ClaudeCheckpoint, ClaudeIngestResponse } from "../types";

/**
 * 現状スクレイパー（apps/scraper）の対象アカウントは1つのみ（TARGET_USER、デフォルト
 * "Zabi_pokeka"）なので、このページでもハードコードする。複数アカウント対応時はここを
 * 選択式に変更する。
 */
const AUTHOR_USERNAME = "Zabi_pokeka";

type PreviewRow =
  | { index: number; ok: true; post: ClaudePostInput }
  | { index: number; ok: false; externalPostId: string | null; error: string };

function externalPostIdOfRaw(raw: unknown): string | null {
  if (typeof raw === "object" && raw !== null && "externalPostId" in raw) {
    const value = (raw as Record<string, unknown>).externalPostId;
    if (typeof value === "string") return value;
  }
  return null;
}

function formatDateField(value: ClaudePostInput["extractedLotteries"][number]["applicationEnd"]): string {
  if (value === null) return "―";
  if (typeof value === "string") return value;
  if (value.at) return value.rawText ? `${value.at}（${value.rawText}）` : value.at;
  if (value.date) return value.rawText ? `${value.date}（${value.rawText}）` : value.date;
  if (value.rawText) return `（${value.rawText}）`;
  return "―";
}

function computeLatestCandidate(rows: PreviewRow[]): { externalPostId: string; publishedAt: string } | null {
  let best: { externalPostId: string; publishedAt: string; ts: number } | null = null;
  for (const row of rows) {
    if (!row.ok || !row.post.publishedAt) continue;
    const ts = new Date(row.post.publishedAt).getTime();
    if (Number.isNaN(ts)) continue;
    if (!best || ts > best.ts) {
      best = { externalPostId: row.post.externalPostId, publishedAt: row.post.publishedAt, ts };
    }
  }
  return best ? { externalPostId: best.externalPostId, publishedAt: best.publishedAt } : null;
}

export function ClaudeIngestPage() {
  // --- チェックポイント ---
  const [checkpoint, setCheckpoint] = useState<ClaudeCheckpoint | null>(null);
  const [checkpointLoading, setCheckpointLoading] = useState(true);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  const [checkpointFormPostId, setCheckpointFormPostId] = useState("");
  const [checkpointFormPublishedAt, setCheckpointFormPublishedAt] = useState("");
  const [updatingCheckpoint, setUpdatingCheckpoint] = useState(false);

  const loadCheckpoint = useCallback(async () => {
    setCheckpointLoading(true);
    setCheckpointError(null);
    try {
      const res = await apiRequest<ClaudeCheckpoint>(`/admin/claude-ingest/checkpoint?authorUsername=${encodeURIComponent(AUTHOR_USERNAME)}`);
      setCheckpoint(res);
    } catch (e) {
      setCheckpointError(e instanceof ApiError ? e.message : "チェックポイントの取得に失敗しました");
    } finally {
      setCheckpointLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCheckpoint();
  }, [loadCheckpoint]);

  async function handleUpdateCheckpoint() {
    if (!checkpointFormPostId.trim() || !checkpointFormPublishedAt.trim()) return;
    setUpdatingCheckpoint(true);
    setCheckpointError(null);
    try {
      const res = await apiRequest<ClaudeCheckpoint>("/admin/claude-ingest/checkpoint", {
        method: "PUT",
        body: {
          authorUsername: AUTHOR_USERNAME,
          externalPostId: checkpointFormPostId.trim(),
          publishedAt: checkpointFormPublishedAt.trim(),
        },
      });
      setCheckpoint(res);
    } catch (e) {
      setCheckpointError(e instanceof ApiError ? e.message : "チェックポイントの更新に失敗しました");
    } finally {
      setUpdatingCheckpoint(false);
    }
  }

  // --- JSON貼り付け・Validate・プレビュー ---
  const [jsonText, setJsonText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [previewRows, setPreviewRows] = useState<PreviewRow[] | null>(null);
  const [selected, setSelected] = useState<Record<number, boolean>>({});

  function handleValidate() {
    setParseError(null);
    setPreviewRows(null);
    setSaveResults(null);
    setSaveError(null);

    let raw: unknown;
    try {
      raw = JSON.parse(jsonText);
    } catch (e) {
      setParseError(`JSONの形式が不正です: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!Array.isArray(raw)) {
      setParseError("貼り付けるJSONは配列（投稿の一覧）である必要があります");
      return;
    }
    if (raw.length === 0) {
      setParseError("配列が空です");
      return;
    }

    const rows: PreviewRow[] = raw.map((item, index) => {
      const parsed = ClaudePostInputSchema.safeParse(item);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join(" / ");
        return { index, ok: false, externalPostId: externalPostIdOfRaw(item), error: message };
      }
      return { index, ok: true, post: parsed.data };
    });

    setPreviewRows(rows);
    const initialSelected: Record<number, boolean> = {};
    for (const row of rows) {
      if (row.ok) initialSelected[row.index] = true;
    }
    setSelected(initialSelected);
  }

  function handleFillCandidate() {
    const candidate = computeLatestCandidate(previewRows ?? []);
    if (!candidate) return;
    setCheckpointFormPostId(candidate.externalPostId);
    setCheckpointFormPublishedAt(candidate.publishedAt);
  }

  // --- 保存 ---
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveResults, setSaveResults] = useState<ClaudeIngestResponse["results"] | null>(null);

  /**
   * 1投稿ずつ個別のHTTPリクエストで送る（まとめて送ると、Cloudflare Workersの
   * 「1リクエストあたりのサブリクエスト数上限」（1投稿ごとに複数回DBへ問い合わせるため、
   * 投稿数が増えると同一リクエスト内で上限に達する）に引っかかることが実際に確認できたため。
   * 自動収集パイプライン（scraper）が/ingestを1投稿ずつ呼ぶのと同じ粒度に揃えている。
   * 逐次実行で結果を都度画面へ反映する（1件失敗しても他の投稿の送信は続ける）。
   */
  async function handleSave() {
    if (!previewRows) return;
    const postsToSave = previewRows.filter((row): row is PreviewRow & { ok: true } => row.ok && Boolean(selected[row.index])).map((row) => row.post);
    if (postsToSave.length === 0) return;

    setSaving(true);
    setSaveError(null);
    setSaveResults([]);

    for (const post of postsToSave) {
      try {
        const res = await apiRequest<ClaudeIngestResponse>("/admin/claude-ingest", {
          method: "POST",
          body: { posts: [post] },
        });
        setSaveResults((prev) => [...(prev ?? []), ...res.results]);
      } catch (e) {
        setSaveResults((prev) => [
          ...(prev ?? []),
          {
            externalPostId: post.externalPostId,
            ok: false,
            kind: "server_error",
            message: e instanceof ApiError ? e.message : "保存に失敗しました",
          },
        ]);
      }
    }

    setSaving(false);
  }

  const selectedCount = previewRows ? previewRows.filter((row) => row.ok && selected[row.index]).length : 0;

  return (
    <div className="page">
      <div className="header-row">
        <h1>Claude投入</h1>
        <Link to="/">一覧へ戻る</Link>
      </div>
      <p className="muted">
        Claude in Chrome等でXの投稿を手動確認して生成したJSONを貼り付け、検証・確認したうえで既存DBへ投入します。
        保存処理は自動収集パイプラインの<code>POST /ingest</code>と同じ共通処理を使います。
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Xの確認チェックポイント</h2>
        <p className="muted">
          「最後にXで確認した投稿」を表す目印です（DBへ保存したかどうかとは無関係）。抽選対象外の投稿を確認した場合も、
          ここまで確認済みとして更新できます。
        </p>
        {checkpointLoading ? (
          <p className="muted">読み込み中…</p>
        ) : (
          <p>
            最終確認: externalPostId=<strong>{checkpoint?.externalPostId ?? "（未設定）"}</strong> / publishedAt=
            <strong>{checkpoint?.publishedAt ?? "―"}</strong> / checkedAt=<strong>{checkpoint?.checkedAt ?? "―"}</strong>
          </p>
        )}
        <div className="field" style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <label htmlFor="checkpoint-post-id">externalPostId</label>
            <input
              id="checkpoint-post-id"
              type="text"
              value={checkpointFormPostId}
              onChange={(e) => setCheckpointFormPostId(e.target.value)}
              style={{ width: 220 }}
            />
          </div>
          <div>
            <label htmlFor="checkpoint-published-at">publishedAt</label>
            <input
              id="checkpoint-published-at"
              type="text"
              value={checkpointFormPublishedAt}
              onChange={(e) => setCheckpointFormPublishedAt(e.target.value)}
              placeholder="2026-08-31T11:15:00+09:00"
              style={{ width: 240 }}
            />
          </div>
          <button type="button" className="secondary" onClick={handleFillCandidate} disabled={!previewRows}>
            貼り付けた投稿の中で最新のものを候補入力
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void handleUpdateCheckpoint()}
            disabled={updatingCheckpoint || !checkpointFormPostId.trim() || !checkpointFormPublishedAt.trim()}
          >
            {updatingCheckpoint ? "更新中…" : "この内容でチェックポイントを更新"}
          </button>
        </div>
        {checkpointError ? <p className="error-text">{checkpointError}</p> : null}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>投稿JSONの貼り付け</h2>
        <textarea
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          rows={12}
          style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
          placeholder="Claude in Chromeで生成したJSON配列をここに貼り付けてください"
        />
        <div style={{ marginTop: 8 }}>
          <button type="button" className="secondary" onClick={handleValidate} disabled={!jsonText.trim()}>
            Validate
          </button>
        </div>
        {parseError ? <p className="error-text">{parseError}</p> : null}
      </div>

      {previewRows ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>プレビュー（{previewRows.length}件中 {selectedCount}件を保存対象として選択中）</h2>
          {previewRows.map((row) => (
            <div key={row.index} className="card" style={{ marginBottom: 8, background: row.ok ? undefined : "#fff5f5" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input
                  type="checkbox"
                  checked={row.ok ? Boolean(selected[row.index]) : false}
                  disabled={!row.ok}
                  onChange={(e) => setSelected((prev) => ({ ...prev, [row.index]: e.target.checked }))}
                  aria-label={`投稿${row.index + 1}を保存対象にする`}
                />
                <strong>externalPostId: {row.ok ? row.post.externalPostId : (row.externalPostId ?? "（不明）")}</strong>
                {row.ok ? <span className="muted">postType: {row.post.postType}</span> : null}
                <span>{row.ok ? "✅" : "❌"}</span>
              </div>

              {!row.ok ? (
                <p className="error-text" style={{ marginTop: 6 }}>
                  {row.error}
                </p>
              ) : row.post.extractedLotteries.length === 0 ? (
                <p className="muted" style={{ marginTop: 6 }}>
                  対象外（抽選情報なし）
                </p>
              ) : (
                <div style={{ overflowX: "auto", marginTop: 6 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                        <th style={{ padding: "4px 8px" }}>商品名</th>
                        <th style={{ padding: "4px 8px" }}>店舗名</th>
                        <th style={{ padding: "4px 8px" }}>応募開始</th>
                        <th style={{ padding: "4px 8px" }}>応募終了</th>
                        <th style={{ padding: "4px 8px" }}>当選発表</th>
                        <th style={{ padding: "4px 8px" }}>URL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {row.post.extractedLotteries.map((lottery, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid #f0f0f0" }}>
                          <td style={{ padding: "4px 8px" }}>{lottery.productNameRaw ?? "―"}</td>
                          <td style={{ padding: "4px 8px" }}>{lottery.storeNameRaw ?? "―"}</td>
                          <td style={{ padding: "4px 8px" }}>{formatDateField(lottery.applicationStart)}</td>
                          <td style={{ padding: "4px 8px" }}>{formatDateField(lottery.applicationEnd)}</td>
                          <td style={{ padding: "4px 8px" }}>{formatDateField(lottery.resultAnnouncement)}</td>
                          <td style={{ padding: "4px 8px", wordBreak: "break-all" }}>{lottery.applicationUrl ?? "―"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}

          <button type="button" className="primary" onClick={() => void handleSave()} disabled={saving || selectedCount === 0}>
            {saving ? `保存中…（${saveResults?.length ?? 0}/${selectedCount}件）` : `選択した${selectedCount}件を保存`}
          </button>
          {saveError ? <p className="error-text">{saveError}</p> : null}
        </div>
      ) : null}

      {saveResults ? (
        <div className="card">
          <h2>保存結果</h2>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={{ padding: "4px 8px" }}>externalPostId</th>
                <th style={{ padding: "4px 8px" }}>結果</th>
                <th style={{ padding: "4px 8px" }}>抽選反映</th>
              </tr>
            </thead>
            <tbody>
              {saveResults.map((result, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f0f0f0" }}>
                  <td style={{ padding: "4px 8px" }}>{result.externalPostId ?? "―"}</td>
                  <td style={{ padding: "4px 8px" }}>
                    {result.ok ? result.action : `失敗（${result.kind === "validation_failed" ? "検証エラー" : result.message ?? "エラー"}）`}
                  </td>
                  <td style={{ padding: "4px 8px" }}>
                    {result.analysis ? `${result.analysis.action}（${result.analysis.lotteryCount}件）` : "―"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
