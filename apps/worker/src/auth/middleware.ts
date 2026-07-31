import type { Context, Next } from "hono";
import type { AppEnv } from "../env.ts";
import { AccessTokenExpiredError, verifyAccessToken } from "./accessToken.ts";
import { AuthConfigError, resolveAuthRuntimeConfig } from "./config.ts";
import { ApiError, apiErrorJson } from "./errors.ts";
import { findUserByPublicUserId } from "../repositories/userRepository.ts";

/**
 * `/auth/*` と `/me` の入口で必ず先に実行するミドルウェア。
 * 認証設定（ENVIRONMENT・APPLE_CLIENT_ID・JWT署名鍵等）を一括検証し、
 * 不正であれば認証ルートのみを503 AUTH_NOT_CONFIGUREDにする。
 * `/lotteries` 等の既存公開APIはこのミドルウェアを経由しないため無関係（稼働を維持する）。
 * 検証済み設定は `c.get("authConfig")` として後続ハンドラへ渡す（値の再検証・再パースを避ける）。
 */
export async function requireAuthConfigured(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const env = c.get("env");
  try {
    const config = resolveAuthRuntimeConfig(env);
    c.set("authConfig", config);
  } catch (e) {
    const message = e instanceof AuthConfigError ? e.message : "認証機能の設定が不正です";
    // フィールド名のみを含むメッセージを出力する（値そのものは絶対にログへ出さない）。
    console.error(JSON.stringify({ event: "auth_config_error", requestId: c.get("requestId"), message }));
    return apiErrorJson(c, new ApiError("AUTH_NOT_CONFIGURED", message));
  }
  await next();
}

/**
 * Access Tokenを検証し、内部の整数`userId`とpublicUserIdをコンテキストへセットするミドルウェア。
 * `requireAuthConfigured` より後に配置する前提（`authConfig`が既にセットされている）。
 * 以降のハンドラは `c.get("userId")` で所有者チェックを行う（IDORを構造的に防ぐ）。
 */
export async function requireAuth(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const authHeader = c.req.header("Authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(authHeader);
  if (!match) {
    return apiErrorJson(c, new ApiError("UNAUTHORIZED", "Authorizationヘッダがありません"));
  }

  const authConfig = c.get("authConfig")!;

  let claims;
  try {
    claims = await verifyAccessToken(match[1], authConfig.jwtSigningKeys);
  } catch (e) {
    if (e instanceof AccessTokenExpiredError) {
      return apiErrorJson(c, new ApiError("TOKEN_EXPIRED", e.message));
    }
    return apiErrorJson(c, new ApiError("UNAUTHORIZED", "Access Tokenが無効です"));
  }

  const db = c.get("db");
  const user = await findUserByPublicUserId(db, claims.publicUserId);
  if (!user) {
    return apiErrorJson(c, new ApiError("UNAUTHORIZED", "ユーザーが見つかりません"));
  }

  c.set("userId", user.id);
  c.set("publicUserId", user.publicUserId);
  await next();
}
