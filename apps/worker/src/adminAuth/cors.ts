import { cors } from "hono/cors";
import type { Env } from "../env.ts";

/**
 * 管理画面（Phase 7、別アプリとしてCloudflare Pagesにデプロイ）専用のCORS設定。
 * Bearer JWTで認証するためCookieは使わず、`credentials: false`のままで良い
 * （`publicCors.ts`の公開GET API向け設定と同じ方針、許可メソッド・ヘッダーのみ広げる）。
 */
const DEV_ORIGINS = ["http://localhost:5173", "http://localhost:3000"];

export function getAdminWebOrigins(env: Env): string[] {
  const fromEnv = (env.ADMIN_WEB_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return [...DEV_ORIGINS, ...fromEnv];
}

export function adminApiCors() {
  return cors({
    origin: (origin, c) => {
      const env = c.get("env") as Env | undefined;
      const allowed = getAdminWebOrigins(env ?? {});
      return origin && allowed.includes(origin) ? origin : undefined;
    },
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  });
}
