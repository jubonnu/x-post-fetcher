import type { Hono } from "hono";
import { IngestPayloadSchema } from "@x-post/shared";
import type { AppEnv } from "../env.ts";
import { upsertSourcePost } from "../repositories/sourcePostRepository.ts";

/**
 * POST /ingest — 内部取込API（Bearer 認証）。
 * Phase 1: sourcePost のみを検証して upsert。analysis は受け取っても無視する。
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

    // --- upsert（externalPostId / contentHash） ---
    try {
      const result = await upsertSourcePost(c.get("db"), parsed.data.sourcePost);
      return c.json({ ok: true, ...result });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}
