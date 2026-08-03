import type { Hono } from "hono";
import { AppleIdentityTokenError, verifyAppleIdentityToken } from "../auth/apple.ts";
import { signAccessToken, ACCESS_TOKEN_TTL_SECONDS } from "../auth/accessToken.ts";
import { generateAppleClientSecret, exchangeAppleAuthorizationCode } from "../auth/appleTokenExchange.ts";
import {
  requireAppleTokenExchangeConfig,
  resolveAppleTokenExchangeConfig,
  type AppleTokenExchangeRuntimeConfig,
} from "../auth/appleTokenExchangeConfig.ts";
import { AuthConfigError } from "../auth/config.ts";
import { encryptToken, type EncryptedPayload } from "../auth/tokenEncryption.ts";
import { getClientIp } from "../auth/clientIp.ts";
import { ApiError, apiErrorJson } from "../auth/errors.ts";
import { checkRateLimit } from "../auth/rateLimit.ts";
import { appleAuthRequestSchema, refreshRequestSchema, logoutRequestSchema } from "../auth/schemas.ts";
import { recordAuditLog } from "../repositories/auditLogRepository.ts";
import {
  ExpiredRefreshTokenError,
  InvalidRefreshTokenError,
  RefreshTokenReuseDetectedError,
  revokeAllForUser,
  revokeByDeviceId,
  rotateRefreshToken,
} from "../repositories/refreshTokenRepository.ts";
import { issueRefreshToken } from "../repositories/refreshTokenRepository.ts";
import {
  createUserWithAppleIdentityAtomic,
  findUserByAppleSub,
  findUserByInternalId,
  isUniqueConstraintViolation,
  storeEncryptedAppleRefreshToken,
  touchUserOnAppleLogin,
} from "../repositories/userRepository.ts";
import { requireAuth } from "../auth/middleware.ts";
import { sha256Hex } from "../auth/hash.ts";
import type { AppEnv } from "../env.ts";
import { isSqliteBusyError } from "../db/retry.ts";
import type { UserRow } from "../db/schema.ts";

/**
 * ルートハンドラ内の早期returnを、ネストした処理ブロックから外側へ伝える簡易シグナル。
 * 呼び出し側でこの型を見つけたら`response`をそのまま返す。
 */
class ApiResponseSignal extends Error {
  response: Response;
  constructor(response: Response) {
    super("api-response-signal");
    this.name = "ApiResponseSignal";
    this.response = response;
  }
}

const APPLE_AUTH_RATE_LIMIT = { limit: 10, windowMs: 60_000 };
const REFRESH_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

/** production/previewでApple token交換を必須とする環境。development/testは任意設定（構成すれば動く）。 */
const STRICT_APPLE_EXCHANGE_ENVIRONMENTS = new Set(["production", "preview"]);

function toUserResponse(user: { publicUserId: string; displayName: string | null; email: string | null; accountStatus: string; createdAt: string }) {
  return {
    publicUserId: user.publicUserId,
    displayName: user.displayName,
    email: user.email,
    accountStatus: user.accountStatus,
    createdAt: user.createdAt,
  };
}

interface AppleExchangeAttempt {
  success: boolean;
  encrypted?: EncryptedPayload;
}

/**
 * authorizationCode交換+暗号化を試みる（DB書き込みは行わない、純粋に外部I/O+暗号化のみ）。
 * 失敗時は例外を投げず`{success:false}`を返す（呼び出し側で必須/ベストエフォートを判断する）。
 * トークンの生値・クライアントシークレットはログへ出さない。
 */
async function attemptAppleExchange(params: {
  exchangeConfig: AppleTokenExchangeRuntimeConfig;
  appleClientId: string;
  authorizationCode: string;
}): Promise<AppleExchangeAttempt> {
  try {
    const clientSecret = await generateAppleClientSecret(params.exchangeConfig.clientSecretConfig);
    const result = await exchangeAppleAuthorizationCode(params.authorizationCode, clientSecret, {
      clientId: params.appleClientId,
    });
    const encrypted = await encryptToken(result.appleRefreshToken, params.exchangeConfig.encryptionKeys);
    return { success: true, encrypted };
  } catch (e) {
    console.error(
      JSON.stringify({ event: "apple_token_exchange_failed", message: e instanceof Error ? e.message : "unknown error" })
    );
    return { success: false };
  }
}

/**
 * Mobile-G2A: 認証API。
 * POST /auth/apple, /auth/refresh, /auth/logout, /auth/logout-all
 * （GET/DELETE /me は routes/me.ts）
 */
export function registerAuth(app: Hono<AppEnv>): void {
  app.post("/auth/apple", async (c) => {
    const ip = getClientIp(c);
    if (!checkRateLimit(`apple:${ip}`, APPLE_AUTH_RATE_LIMIT.limit, APPLE_AUTH_RATE_LIMIT.windowMs)) {
      return apiErrorJson(c, new ApiError("RATE_LIMITED", "リクエストが多すぎます。しばらくしてから再試行してください"));
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストボディが不正です"));
    }

    const parsed = appleAuthRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));
    }

    // requireAuthConfigured（/auth/*へ適用済み）が既に検証済みのため、ここでは取り出すだけでよい
    const authConfig = c.get("authConfig")!;
    const env = c.get("env");
    const isStrictEnvironment = STRICT_APPLE_EXCHANGE_ENVIRONMENTS.has(authConfig.environment);

    // production/previewはApple token交換設定を必須にする（未設定・不正なら503、identityToken検証より前に確認する）。
    let exchangeConfig: AppleTokenExchangeRuntimeConfig | undefined;
    if (isStrictEnvironment) {
      try {
        exchangeConfig = requireAppleTokenExchangeConfig(env, authConfig.appleClientId);
      } catch (e) {
        return apiErrorJson(
          c,
          new ApiError("AUTH_NOT_CONFIGURED", e instanceof AuthConfigError ? e.message : "設定エラー")
        );
      }
    } else {
      // development/testでは任意設定（構成されていれば同じロジックを通す、未構成ならスキップ）
      exchangeConfig = resolveAppleTokenExchangeConfig(env, authConfig.appleClientId);
    }

    let claims;
    try {
      claims = await verifyAppleIdentityToken({
        identityToken: parsed.data.identityToken,
        rawNonce: parsed.data.rawNonce,
        appleClientId: authConfig.appleClientId,
      });
    } catch (e) {
      const message = e instanceof AppleIdentityTokenError ? e.message : "identityTokenの検証に失敗しました";
      return apiErrorJson(c, new ApiError("UNAUTHORIZED", message));
    }

    const db = c.get("db");

    // ロック競合（SQLITE_BUSY）対策は接続時のPRAGMA busy_timeout（db/client.node.ts）に委ねる。
    // 途中のearly returnは`ApiResponseSignal`で外側へ伝える。
    let user: UserRow;
    let refreshToken: string;
    try {
      const result = await (async () => {
        const existing = await findUserByAppleSub(db, claims.sub);

        let resolvedUser: UserRow;
        // 新規ユーザーが原子的トランザクション内でRefresh Tokenまで発行済みの場合はこちらに入る
        // （既存ユーザー分岐・フォールバック分岐では未設定のまま後段の共通発行処理を使う）。
        let refreshTokenFromTransaction: string | undefined;

        if (!existing) {
          // ---- 新規ユーザー ----
          let encryptedAppleToken: { ciphertextBase64: string; ivBase64: string; keyVersion: string } | undefined;

          if (exchangeConfig) {
            if (!parsed.data.authorizationCode) {
              throw new ApiResponseSignal(apiErrorJson(c, new ApiError("VALIDATION_ERROR", "authorizationCodeが必要です")));
            }

            const attempt = await attemptAppleExchange({
              exchangeConfig,
              appleClientId: authConfig.appleClientId,
              authorizationCode: parsed.data.authorizationCode,
            });

            if (!attempt.success || !attempt.encrypted) {
              // 交換・暗号化のいずれかに失敗した場合、DBへは一切書き込まずここで終了する
              // （ユーザー行・identity行を中途半端な状態で残さない）。
              // authorizationCodeは単発利用のため、モバイル側でSign in with Appleを再実行して
              // 新しいコードを取得する必要がある。
              throw new ApiResponseSignal(
                apiErrorJson(
                  c,
                  new ApiError(
                    "AUTH_PROVIDER_UNAVAILABLE",
                    "Appleとの連携に失敗しました。Sign in with Appleを再度実行してください"
                  )
                )
              );
            }

            encryptedAppleToken = {
              ciphertextBase64: attempt.encrypted.ciphertextBase64,
              ivBase64: attempt.encrypted.ivBase64,
              keyVersion: attempt.encrypted.keyVersion,
            };
          }
          // exchangeConfigが無い場合（development/testかつApple token交換が未構成）は
          // encryptedAppleToken未設定のまま、従来通りApple連携無しで作成する。

          try {
            const created = await createUserWithAppleIdentityAtomic(db, {
              profile: {
                sub: claims.sub,
                email: claims.email,
                emailIsPrivateRelay: claims.isPrivateEmail,
                displayName: parsed.data.fullName,
              },
              encryptedAppleToken,
              device: { deviceId: parsed.data.deviceId, deviceName: parsed.data.deviceName },
              audit: { ipHash: await sha256Hex(ip), requestId: c.get("requestId") },
            });
            resolvedUser = created.user;
            refreshTokenFromTransaction = created.refreshToken.raw;
          } catch (e) {
            if (!isUniqueConstraintViolation(e)) throw e;
            // 同一Apple subでの同時初回ログイン: 別リクエストが先にユーザーを作成済み。
            // 500にはせず、既存ユーザーとして再照会してログインを継続する
            // （両リクエストが最終的に同じpublicUserIdを返す）。
            const winner = await findUserByAppleSub(db, claims.sub);
            if (!winner) throw e; // 理論上到達しないが、念のため元エラーを再送出する
            resolvedUser = winner.user;
          }
        } else {
          // ---- 既存ユーザーの再ログイン ----
          await touchUserOnAppleLogin(db, {
            userId: existing.user.id,
            identityId: existing.identity.id,
            profile: {
              sub: claims.sub,
              email: claims.email,
              emailIsPrivateRelay: claims.isPrivateEmail,
              // AppleがfullNameを送ってきても、既にdisplayName保存済みなら上書きしない
              // （既存値を消す方向の変更はしない、Mobile-G4 Hardening）。
              displayName: !existing.user.displayName ? parsed.data.fullName : undefined,
            },
          });

          if (exchangeConfig) {
            const hasStoredToken = Boolean(
              existing.identity.appleRefreshTokenCiphertext &&
                existing.identity.appleRefreshTokenIv &&
                existing.identity.appleRefreshTokenKeyVersion
            );

            if (parsed.data.authorizationCode) {
              const attempt = await attemptAppleExchange({
                exchangeConfig,
                appleClientId: authConfig.appleClientId,
                authorizationCode: parsed.data.authorizationCode,
              });

              if (attempt.success && attempt.encrypted) {
                // Appleが新しいRefresh Tokenを返した場合、安全に上書きする。
                await storeEncryptedAppleRefreshToken(db, {
                  identityId: existing.identity.id,
                  ciphertextBase64: attempt.encrypted.ciphertextBase64,
                  ivBase64: attempt.encrypted.ivBase64,
                  keyVersion: attempt.encrypted.keyVersion,
                });
              } else if (!hasStoredToken) {
                // 保存済みトークンが無く、今回の交換にも失敗した場合のみログインを拒否する。
                throw new ApiResponseSignal(
                  apiErrorJson(
                    c,
                    new ApiError(
                      "AUTH_PROVIDER_UNAVAILABLE",
                      "Appleとの連携に失敗しました。Sign in with Appleを再度実行してください"
                    )
                  )
                );
              }
              // hasStoredToken===true の場合は交換失敗を無視してログインを継続する。
            } else if (!hasStoredToken) {
              throw new ApiResponseSignal(apiErrorJson(c, new ApiError("VALIDATION_ERROR", "authorizationCodeが必要です")));
            }
          }

          resolvedUser = (await findUserByInternalId(db, existing.user.id))!;
        }

        let resolvedRefreshToken: string;
        if (refreshTokenFromTransaction) {
          // 新規ユーザー作成の原子的トランザクション内で既に発行済み（二重発行を避ける）。
          resolvedRefreshToken = refreshTokenFromTransaction;
        } else {
          const issued = await issueRefreshToken(db, {
            userId: resolvedUser.id,
            deviceId: parsed.data.deviceId,
            deviceName: parsed.data.deviceName,
          });
          resolvedRefreshToken = issued.raw;

          await recordAuditLog(db, {
            userId: resolvedUser.id,
            action: "login",
            detail: { provider: "apple", deviceId: parsed.data.deviceId },
            ipHash: await sha256Hex(ip),
            requestId: c.get("requestId"),
          });
        }

        return { user: resolvedUser, refreshToken: resolvedRefreshToken };
      })();
      user = result.user;
      refreshToken = result.refreshToken;
    } catch (e) {
      if (e instanceof ApiResponseSignal) return e.response;
      if (isSqliteBusyError(e)) {
        // 極端な同時アクセスでPRAGMA busy_timeoutの猶予を超えた場合の最終防御。
        // 生の例外を漏らさず、クライアントが再試行可能なことが分かる形で返す。
        return apiErrorJson(
          c,
          new ApiError("SERVICE_BUSY", "一時的にサーバーが混み合っています。しばらくしてから再試行してください")
        );
      }
      throw e;
    }

    const accessToken = await signAccessToken({ publicUserId: user.publicUserId, signingKeys: authConfig.jwtSigningKeys });

    return c.json({
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user: toUserResponse(user),
    });
  });

  app.post("/auth/refresh", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストボディが不正です"));
    }

    const parsed = refreshRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));
    }

    if (!checkRateLimit(`refresh:${parsed.data.deviceId}`, REFRESH_RATE_LIMIT.limit, REFRESH_RATE_LIMIT.windowMs)) {
      return apiErrorJson(c, new ApiError("RATE_LIMITED", "リクエストが多すぎます。しばらくしてから再試行してください"));
    }

    const db = c.get("db");
    try {
      const rotated = await rotateRefreshToken(db, { rawToken: parsed.data.refreshToken, deviceId: parsed.data.deviceId });
      const user = await findUserByInternalId(db, rotated.userId);
      if (!user) {
        return apiErrorJson(c, new ApiError("UNAUTHORIZED", "ユーザーが見つかりません"));
      }

      const accessToken = await signAccessToken({ publicUserId: user.publicUserId, signingKeys: c.get("authConfig")!.jwtSigningKeys });

      return c.json({ accessToken, refreshToken: rotated.raw, expiresIn: ACCESS_TOKEN_TTL_SECONDS });
    } catch (e) {
      if (e instanceof RefreshTokenReuseDetectedError) {
        await recordAuditLog(db, {
          userId: e.userId,
          action: "refresh_reuse_detected",
          detail: { deviceId: parsed.data.deviceId },
          requestId: c.get("requestId"),
        });
        return apiErrorJson(c, new ApiError("UNAUTHORIZED", "セッションが無効化されました。再度ログインしてください"));
      }
      if (e instanceof ExpiredRefreshTokenError) {
        return apiErrorJson(c, new ApiError("TOKEN_EXPIRED", e.message));
      }
      if (e instanceof InvalidRefreshTokenError) {
        return apiErrorJson(c, new ApiError("UNAUTHORIZED", e.message));
      }
      throw e;
    }
  });

  app.post("/auth/logout", requireAuth, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const parsed = logoutRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));
    }

    const db = c.get("db");
    const userId = c.get("userId")!;
    await revokeByDeviceId(db, userId, parsed.data.deviceId);
    await recordAuditLog(db, {
      userId,
      action: "logout",
      detail: { deviceId: parsed.data.deviceId },
      requestId: c.get("requestId"),
    });

    return c.json({ ok: true });
  });

  app.post("/auth/logout-all", requireAuth, async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const revokedCount = await revokeAllForUser(db, userId, "logout_all");
    await recordAuditLog(db, { userId, action: "logout_all", requestId: c.get("requestId") });

    return c.json({ ok: true, revokedCount });
  });
}
