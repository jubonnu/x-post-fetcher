import { eq } from "drizzle-orm";
import { classifyUrl } from "@x-post/shared";
import type { Db } from "../db/client.ts";
import { lotteries } from "../db/schema.ts";
import { resolveUrl } from "./resolveUrl.ts";

/**
 * lottery の applicationUrl を HTTP リダイレクト追跡で解決し、
 * resolved_application_url / application_url_http_status / url_resolved_at を更新する（Phase 4）。
 * t.co 等の短縮URLが展開され、解決後の URL から urlType が確定できる場合は
 * applicationUrl 自体も最終 URL に差し替える。
 * 解決失敗（タイムアウト・ネットワークエラー）は何もしない（ジョブはリトライされる）。
 */
export async function resolveLotteryUrls(db: Db, lotteryId: number): Promise<void> {
  const rows = await db.select().from(lotteries).where(eq(lotteries.id, lotteryId));
  const row = rows[0];
  if (!row?.applicationUrl) return;

  const result = await resolveUrl(row.applicationUrl);

  // ネットワーク失敗（resolvedUrl も httpStatus も null）はリトライに任せる
  if (result.resolvedUrl === null && result.httpStatus === null) {
    throw new Error(result.error ?? "resolve failed");
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = {
    resolvedApplicationUrl: result.resolvedUrl,
    applicationUrlHttpStatus: result.httpStatus,
    urlResolvedAt: now,
    updatedAt: now,
  };

  // 解決後 URL が元 URL と異なり、かつ種別が改善された場合は applicationUrl を上書き
  if (result.resolvedUrl && result.resolvedUrl !== row.applicationUrl) {
    const classified = classifyUrl(result.resolvedUrl);
    if (classified.urlType !== "unknown") {
      updates.applicationUrl = result.resolvedUrl;
    }
  }

  await db.update(lotteries).set(updates).where(eq(lotteries.id, lotteryId));
}
