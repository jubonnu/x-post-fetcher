import type { Context, Next } from "hono";
import type { AppEnv } from "../env.ts";
import { findAdminUserById } from "../repositories/adminUserRepository.ts";
import { AdminAuthConfigError, resolveAdminAuthConfig } from "./config.ts";
import { AdminTokenError, verifyAdminToken } from "./token.ts";

/**
 * `/admin/*` の入口で必ず先に実行するミドルウェア。管理画面認証設定
 * （`ADMIN_INVITE_CODE`・`ADMIN_JWT_SECRET`）が未設定/不正なら`/admin/*`全体を
 * 503 AUTH_NOT_CONFIGUREDにする（モバイル向け`requireAuthConfigured`と同じ方針）。
 */
export async function requireAdminAuthConfigured(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const env = c.get("env");
  try {
    c.set("adminAuthConfig", resolveAdminAuthConfig(env));
  } catch (e) {
    const message = e instanceof AdminAuthConfigError ? e.message : "管理画面の認証設定が不正です";
    console.error(JSON.stringify({ event: "admin_auth_config_error", requestId: c.get("requestId"), message }));
    return c.json({ error: { code: "AUTH_NOT_CONFIGURED", message, requestId: c.get("requestId") } }, 503);
  }
  await next();
}

/** Bearer JWTを検証し、`adminUserId`をコンテキストへセットする。`requireAdminAuthConfigured`より後に配置する前提。 */
export async function requireAdminAuth(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const authHeader = c.req.header("Authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(authHeader);
  if (!match) {
    return c.json({ error: { code: "UNAUTHORIZED", message: "Authorizationヘッダがありません", requestId: c.get("requestId") } }, 401);
  }

  const { jwtSecret } = c.get("adminAuthConfig")!;

  let claims;
  try {
    claims = await verifyAdminToken(match[1], jwtSecret);
  } catch (e) {
    if (!(e instanceof AdminTokenError)) throw e;
    return c.json({ error: { code: "UNAUTHORIZED", message: "管理者トークンが無効です", requestId: c.get("requestId") } }, 401);
  }

  const db = c.get("db");
  const adminUser = await findAdminUserById(db, claims.adminUserId);
  if (!adminUser) {
    return c.json({ error: { code: "UNAUTHORIZED", message: "管理者アカウントが見つかりません", requestId: c.get("requestId") } }, 401);
  }

  c.set("adminUserId", adminUser.id);
  await next();
}
