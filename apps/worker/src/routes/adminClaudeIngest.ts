import type { Hono } from "hono";
import { z } from "zod";
import { ClaudePostInputSchema } from "@x-post/shared";
import { requireAdminAuth } from "../adminAuth/middleware.ts";
import { ApiError, apiErrorJson } from "../auth/errors.ts";
import type { AppEnv } from "../env.ts";
import { getClaudeCheckpoint, setClaudeCheckpoint } from "../repositories/scrapeAuthorStateRepository.ts";
import { transformClaudePost } from "../services/claudeIngestTransform.ts";
import { ingestPost } from "../services/ingestPost.ts";

async function parseJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

const claudeIngestRequestSchema = z.object({
  posts: z.array(z.unknown()).min(1),
});

const setCheckpointSchema = z.object({
  authorUsername: z.string().min(1),
  externalPostId: z.string().min(1),
  publishedAt: z.string().min(1),
});

function externalPostIdOf(rawPost: unknown): string | null {
  if (typeof rawPost === "object" && rawPost !== null && "externalPostId" in rawPost) {
    const value = (rawPost as Record<string, unknown>).externalPostId;
    if (typeof value === "string") return value;
  }
  return null;
}

/**
 * 管理画面「Claude投入」用API。Claude in Chrome等で手動生成したJSON（flattened形式）を
 * 既存/ingestと同じ`ingestPost`（services/ingestPost.ts）経由でDBへ反映する。
 * `requireAdminAuth`で保護し、`INGEST_TOKEN`は一切参照しない（ブラウザに露出させない）。
 * あわせて、将来Claude in Chromeを定期実行する際の取りこぼし防止用チェックポイント
 * （scrapeAuthorStatesテーブルの拡張カラム）の取得・更新エンドポイントも提供する。
 */
export function registerAdminClaudeIngest(app: Hono<AppEnv>): void {
  app.post("/admin/claude-ingest", requireAdminAuth, async (c) => {
    const body = await parseJsonBody(c);
    if (body === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストボディが不正です"));

    const parsed = claudeIngestRequestSchema.safeParse(body);
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "postsは1件以上の配列である必要があります"));

    const db = c.get("db");
    const fetchedAtIso = new Date().toISOString();
    const results: unknown[] = [];

    for (const rawPost of parsed.data.posts) {
      const postParsed = ClaudePostInputSchema.safeParse(rawPost);
      if (!postParsed.success) {
        results.push({
          externalPostId: externalPostIdOf(rawPost),
          ok: false,
          kind: "validation_failed",
          issues: postParsed.error.issues,
        });
        continue;
      }

      try {
        const payload = await transformClaudePost(postParsed.data, fetchedAtIso);
        const result = await ingestPost(db, payload);
        if (result.ok) {
          const { logFields: _logFields, ...rest } = result;
          results.push(rest);
        } else {
          results.push({ externalPostId: postParsed.data.externalPostId, ...result });
        }
      } catch (e) {
        results.push({
          externalPostId: postParsed.data.externalPostId,
          ok: false,
          kind: "server_error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return c.json({ results });
  });

  app.get("/admin/claude-ingest/checkpoint", requireAdminAuth, async (c) => {
    const authorUsername = c.req.query("authorUsername");
    if (!authorUsername) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "authorUsernameは必須です"));

    const db = c.get("db");
    const checkpoint = await getClaudeCheckpoint(db, authorUsername);
    return c.json(checkpoint);
  });

  app.put("/admin/claude-ingest/checkpoint", requireAdminAuth, async (c) => {
    const body = await parseJsonBody(c);
    if (body === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストボディが不正です"));

    const parsed = setCheckpointSchema.safeParse(body);
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));

    const db = c.get("db");
    await setClaudeCheckpoint(db, parsed.data.authorUsername, {
      externalPostId: parsed.data.externalPostId,
      publishedAt: parsed.data.publishedAt,
    });
    const checkpoint = await getClaudeCheckpoint(db, parsed.data.authorUsername);
    return c.json(checkpoint);
  });
}
