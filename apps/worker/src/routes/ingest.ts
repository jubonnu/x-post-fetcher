import type { Hono } from "hono";
import { IngestPayloadSchema } from "@x-post/shared";
import type { AppEnv } from "../env.ts";
import { upsertSourcePost } from "../repositories/sourcePostRepository.ts";
import { persistAnalysis } from "../repositories/analysisRepository.ts";

/**
 * POST /ingest — 内部取込API（Bearer 認証）。
 * sourcePost を upsert し、analysis があれば contentHash 判定のうえ永続化する
 * （同一 contentHash は reused、変われば inserted で再解析）。
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

    // --- Zod 検証 ---
    const parsed = IngestPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "validation_failed", issues: parsed.error.issues }, 422);
    }

    // --- sourcePost upsert（externalPostId / contentHash） ---
    const db = c.get("db");
    let result;
    try {
      result = await upsertSourcePost(db, parsed.data.sourcePost);
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }

    // --- analysis 永続化（あれば）。解析失敗でも sourcePost は保持済み ---
    let analysis: { action: string; lotteryCount: number; lotteryResults?: unknown[] } | undefined;
    if (parsed.data.analysis) {
      try {
        analysis = await persistAnalysis(db, result.sourcePostId, parsed.data.analysis);
      } catch (e) {
        analysis = { action: "failed", lotteryCount: 0 };
        console.error(`[ingest] analysis 永続化失敗: ${e instanceof Error ? e.message : e}`);
      }
    }

    // 構造化ログ（rawHtml / cleanedHtml は出力しない）
    console.log(
      JSON.stringify({
        batchId: parsed.data.batchId ?? null,
        sourcePostId: result.sourcePostId,
        externalPostId: result.externalPostId,
        action: result.action,
        postType: parsed.data.analysis?.postType ?? null,
        isLotteryInformation: parsed.data.analysis?.isLotteryInformation ?? null,
        analysisStatus: parsed.data.analysis?.analysisStatus ?? null,
        extractedLotteryCount: parsed.data.analysis?.extractedLotteries?.length ?? 0,
        analysisAction: analysis?.action ?? null,
        lotteryResults: analysis?.lotteryResults ?? [],
      })
    );

    return c.json({ ok: true, ...result, ...(analysis ? { analysis } : {}) });
  });
}
