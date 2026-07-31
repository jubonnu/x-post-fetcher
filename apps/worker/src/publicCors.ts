import { cors } from "hono/cors";
import type { Env } from "./env.ts";

/**
 * 公開GET API（/lotteries, /lotteries/:id）専用のCORS設定。
 * /ingest や /internal/* には適用しない（app.ts側で個別にmountする）。
 *
 * - 許可Originに一致した場合のみ Access-Control-Allow-Origin を返す（`*` は使わない）
 * - 許可メソッドは GET, OPTIONS のみ
 * - 許可ヘッダーは Content-Type のみ
 * - credentials は使用しない（Cookie等を伴わない公開APIのため）
 */
const DEV_ORIGINS = ["http://localhost:8081", "http://localhost:19006", "http://localhost:3000"];

export function getPublicWebOrigins(env: Env): string[] {
  const fromEnv = (env.PUBLIC_WEB_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return [...DEV_ORIGINS, ...fromEnv];
}

export function publicApiCors() {
  return cors({
    origin: (origin, c) => {
      const env = c.get("env") as Env | undefined;
      const allowed = getPublicWebOrigins(env ?? {});
      return origin && allowed.includes(origin) ? origin : undefined;
    },
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    credentials: false,
  });
}
