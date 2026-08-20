import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { findRecentExternalPostIdsByAuthor } from "../repositories/sourcePostRepository.ts";
import { getScrapeAuthorState, setScrapeAuthorState } from "../repositories/scrapeAuthorStateRepository.ts";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

function checkAuth(c: { get: (k: "env") => { INGEST_TOKEN?: string }; req: { header: (k: string) => string | undefined } }): boolean {
  const token = c.get("env").INGEST_TOKEN;
  const authHeader = c.req.header("Authorization") ?? "";
  return Boolean(token) && authHeader === `Bearer ${token}`;
}

/**
 * 内部API（Bearer認証、既存`/internal/*`・`/ingest`と同じ方式）。
 * scraperの差分取得（前回取得済み地点までプロフィールを遡る方式）が、DOM上で見つけた投稿を
 * 「既に取得済みか」照合するための既知`externalPostId`一覧を返す。scraper（GitHub Actions）は
 * TURSO認証情報を持たずWorker経由でしかDBを参照できないため、この内部APIが必要になる。
 *
 * `needsRecovery`が true（前回の差分取得が既知境界まで安全に到達したと確認できないまま
 * 停止していた＝走査未完了）の場合、`limit`パラメータを無視して全件を返す（リカバリーモード。
 * 直近N件だけの照合では、安全上限より古い位置に埋まった未取得投稿を検出できないため）。
 *
 * GET /internal/source-posts/known-external-ids?authorUsername=<user>&limit=<n>
 */
export function registerSourcePostLookup(app: Hono<AppEnv>): void {
  app.get("/internal/source-posts/known-external-ids", async (c) => {
    if (!checkAuth(c)) return c.json({ ok: false, error: "unauthorized" }, 401);

    const authorUsername = c.req.query("authorUsername");
    if (!authorUsername) {
      return c.json({ ok: false, error: "authorUsername is required" }, 400);
    }

    const limitParam = c.req.query("limit");
    const requestedLimit = limitParam ? Number(limitParam) : DEFAULT_LIMIT;
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, MAX_LIMIT) : DEFAULT_LIMIT;

    const db = c.get("db");
    const state = await getScrapeAuthorState(db, authorUsername);
    const externalPostIds = await findRecentExternalPostIdsByAuthor(db, authorUsername, state.needsRecovery ? undefined : limit);

    return c.json({
      ok: true,
      externalPostIds,
      needsRecovery: state.needsRecovery,
      recoveryCursorExternalPostId: state.recoveryCursorExternalPostId,
      recoveryCursorPublishedAt: state.recoveryCursorPublishedAt,
    });
  });

  /**
   * scraperが1回の差分取得の走査結果（既知境界まで安全に到達できたか＝走査完了/未完了）を
   * 報告する内部API。次回の`GET /internal/source-posts/known-external-ids`のリカバリーモード
   * 判定に使われる。
   *
   * `needsRecovery: true`（走査未完了）の報告は、scraper側でingestより前に行われ、
   * この保存に失敗した場合はscraper側がingestを行わない設計になっている（呼び出し元の責務。
   * 走査未完了の事実を記録し損ねたまま新規投稿だけが既知化されると、次回が誤って通常モードに
   * 戻り取りこぼす致命的な経路になるため）。
   * `needsRecovery: false`（走査完了・自己修復）はingest成功後に呼ばれる想定で、
   * 失敗しても安全側（次回もrecoveryモード継続）。
   *
   * POST /internal/source-posts/scrape-run-result  body: { authorUsername, needsRecovery }
   */
  app.post("/internal/source-posts/scrape-run-result", async (c) => {
    if (!checkAuth(c)) return c.json({ ok: false, error: "unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid_json" }, 400);
    }
    const {
      authorUsername,
      needsRecovery,
      recoveryCursorExternalPostId,
      recoveryCursorPublishedAt,
    } = (body ?? {}) as {
      authorUsername?: unknown;
      needsRecovery?: unknown;
      recoveryCursorExternalPostId?: unknown;
      recoveryCursorPublishedAt?: unknown;
    };
    if (typeof authorUsername !== "string" || !authorUsername || typeof needsRecovery !== "boolean") {
      return c.json({ ok: false, error: "authorUsername (string) and needsRecovery (boolean) are required" }, 400);
    }
    if (recoveryCursorExternalPostId !== undefined && recoveryCursorExternalPostId !== null && typeof recoveryCursorExternalPostId !== "string") {
      return c.json({ ok: false, error: "recoveryCursorExternalPostId must be a string or null" }, 400);
    }
    if (recoveryCursorPublishedAt !== undefined && recoveryCursorPublishedAt !== null && typeof recoveryCursorPublishedAt !== "string") {
      return c.json({ ok: false, error: "recoveryCursorPublishedAt must be a string or null" }, 400);
    }

    const db = c.get("db");
    await setScrapeAuthorState(db, authorUsername, {
      needsRecovery,
      recoveryCursorExternalPostId: recoveryCursorExternalPostId as string | null | undefined,
      recoveryCursorPublishedAt: recoveryCursorPublishedAt as string | null | undefined,
    });

    return c.json({ ok: true });
  });
}
