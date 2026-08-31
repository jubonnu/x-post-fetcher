import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { ingestPost } from "../services/ingestPost.ts";

/**
 * POST /ingest — 内部取込API（Bearer 認証）。
 * sourcePost を upsert し、analysis があれば contentHash 判定のうえ永続化する
 * （同一 contentHash は reused、変われば inserted で再解析）。
 * 検証・保存の実処理は`services/ingestPost.ts`（`/admin/claude-ingest`とも共有）に委譲する。
 */
export function registerIngest(app: Hono<AppEnv>): void {
  app.post("/ingest", async (c) => {
    // --- Bearer 認証 ---
    const token = c.get("env").INGEST_TOKEN;
    const authHeader = c.req.header("Authorization") ?? "";
    if (!token || authHeader !== `Bearer ${token}`) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }

    // --- JSON パース ---
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid_json" }, 400);
    }

    const db = c.get("db");
    const result = await ingestPost(db, body);

    if (!result.ok) {
      if (result.kind === "validation_failed") {
        return c.json({ ok: false, error: "validation_failed", issues: result.issues }, 422);
      }
      return c.json({ ok: false, error: result.message }, 500);
    }

    // 構造化ログ（rawHtml / cleanedHtml は出力しない）
    console.log(
      JSON.stringify({
        batchId: result.logFields.batchId,
        sourcePostId: result.sourcePostId,
        externalPostId: result.externalPostId,
        action: result.action,
        postType: result.logFields.postType,
        isLotteryInformation: result.logFields.isLotteryInformation,
        analysisStatus: result.logFields.analysisStatus,
        extractedLotteryCount: result.logFields.extractedLotteryCount,
        analysisAction: result.analysis?.action ?? null,
        lotteryResults: result.analysis?.lotteryResults ?? [],
      })
    );

    const { logFields: _logFields, ok: _ok, ...rest } = result;
    return c.json({ ok: true, ...rest });
  });
}
