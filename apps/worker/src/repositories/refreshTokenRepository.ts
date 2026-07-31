import { and, eq, isNull } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/client.ts";
import { refreshTokens, type RefreshTokenRow } from "../db/schema.ts";
import { generateRawRefreshToken, hashRefreshToken, refreshTokenExpiryIso } from "../auth/refreshToken.ts";

export class InvalidRefreshTokenError extends Error {
  constructor(message = "Refresh Tokenが無効です") {
    super(message);
    this.name = "InvalidRefreshTokenError";
  }
}

export class ExpiredRefreshTokenError extends Error {
  constructor(message = "Refresh Tokenの有効期限が切れています") {
    super(message);
    this.name = "ExpiredRefreshTokenError";
  }
}

/** 失効済み（ローテーション済み等）のRefresh Tokenが再送された。盗難の兆候として扱う。 */
export class RefreshTokenReuseDetectedError extends Error {
  userId: number;
  constructor(userId: number) {
    super("失効済みのRefresh Tokenが再送されました（再利用検知）");
    this.name = "RefreshTokenReuseDetectedError";
    this.userId = userId;
  }
}

export interface IssuedRefreshToken {
  raw: string;
  row: RefreshTokenRow;
}

export async function issueRefreshToken(
  db: DbOrTx,
  params: { userId: number; deviceId: string; deviceName?: string; rotatedFromId?: number }
): Promise<IssuedRefreshToken> {
  const raw = generateRawRefreshToken();
  const tokenHash = await hashRefreshToken(raw);

  const [row] = await db
    .insert(refreshTokens)
    .values({
      userId: params.userId,
      tokenHash,
      deviceId: params.deviceId,
      deviceName: params.deviceName ?? null,
      rotatedFromId: params.rotatedFromId ?? null,
      expiresAt: refreshTokenExpiryIso(),
    })
    .returning();

  return { raw, row };
}

export interface RotateRefreshTokenResult extends IssuedRefreshToken {
  userId: number;
}

/**
 * 「正常な同時リクエストの競合」と「本物の再利用（盗難の兆候）」を区別するための猶予期間。
 *
 * 検証時に判明した重要な点: Node.jsは単一スレッドのため、`Promise.all`で同時発行した
 * 2つのリクエストであっても、DBアクセスが十分高速だと一方のリクエストが完全に完了してから
 * もう一方が実行され始めることがある。この場合、後発リクエストは自分自身の最初の読み取り
 * 時点で既に`revoked_at`が立っている状態を観測する（条件付きUPDATEで負けるケースと
 * 見分けがつかない）。実運用でもモバイル端末のリトライ等による正常な重複リクエストは
 * 数百ms〜数秒のずれで到着し得るため、直前のローテーションから短時間以内の再送は
 * 「競合に負けた」とみなし、全セッション失効を伴わない単なる401にする。
 * これを超えた古いトークンの再送のみを本物の再利用として扱う。
 */
const DEFAULT_REUSE_GRACE_WINDOW_MS = 1_000;

/** 失効済みトークンの扱いを判定する共通ロジック（初回読み取り時・CAS敗北時どちらからも呼ぶ）。 */
async function classifyAlreadyRevoked(db: Db, row: RefreshTokenRow, graceWindowMs: number): Promise<never> {
  if (row.revokedReason === "rotated" && row.revokedAt) {
    const ageMs = Date.now() - new Date(row.revokedAt).getTime();
    if (ageMs <= graceWindowMs) {
      throw new InvalidRefreshTokenError(
        "Refresh Tokenは直前に別のリクエストで使用されました。新しいトークンを使用してください"
      );
    }
    await revokeAllForUser(db, row.userId, "reuse_detected");
    throw new RefreshTokenReuseDetectedError(row.userId);
  }
  throw new InvalidRefreshTokenError("Refresh Tokenは既に失効しています");
}

/**
 * Refresh Tokenのローテーション。
 * - 未知/ハッシュ不一致 → InvalidRefreshTokenError
 * - deviceId不一致（なりすましの疑い） → InvalidRefreshTokenError
 * - 既に失効済み → `classifyAlreadyRevoked`の判定に従う（猶予期間内は競合、超過は再利用検知）
 * - 有効期限切れ → ExpiredRefreshTokenError
 * - 正常 → 条件付きUPDATE（`WHERE revoked_at IS NULL`）で旧トークンを失効させ、新トークンを発行する。
 *   同一トークンへのほぼ同時の複数リクエストはこのUPDATEで自然に排他される
 *   （SQLite/libSQLは同一行への書き込みを直列化するため、片方だけが実際に行を更新できる）。
 *
 * `reuseGraceWindowMs`はテストからの明示的な調整用（省略時は`DEFAULT_REUSE_GRACE_WINDOW_MS`）。
 */
export async function rotateRefreshToken(
  db: Db,
  params: { rawToken: string; deviceId: string; reuseGraceWindowMs?: number }
): Promise<RotateRefreshTokenResult> {
  const graceWindowMs = params.reuseGraceWindowMs ?? DEFAULT_REUSE_GRACE_WINDOW_MS;
  const tokenHash = await hashRefreshToken(params.rawToken);
  const rows = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
  const existing = rows[0];

  if (!existing) {
    throw new InvalidRefreshTokenError();
  }

  if (existing.deviceId !== params.deviceId) {
    throw new InvalidRefreshTokenError("deviceIdが一致しません");
  }

  if (existing.revokedAt) {
    await classifyAlreadyRevoked(db, existing, graceWindowMs);
  }

  if (new Date(existing.expiresAt).getTime() <= Date.now()) {
    throw new ExpiredRefreshTokenError();
  }

  const now = new Date().toISOString();
  const [revokedRow] = await db
    .update(refreshTokens)
    .set({ revokedAt: now, revokedReason: "rotated", lastUsedAt: now })
    .where(and(eq(refreshTokens.id, existing.id), isNull(refreshTokens.revokedAt)))
    .returning();

  if (!revokedRow) {
    // 条件付きUPDATEに負けた: 別リクエストが先にローテーション済み。最新状態を読み直して判定する。
    const [current] = await db.select().from(refreshTokens).where(eq(refreshTokens.id, existing.id));
    if (current) await classifyAlreadyRevoked(db, current, graceWindowMs);
    throw new InvalidRefreshTokenError();
  }

  const issued = await issueRefreshToken(db, {
    userId: existing.userId,
    deviceId: existing.deviceId,
    deviceName: existing.deviceName ?? undefined,
    rotatedFromId: existing.id,
  });

  return { ...issued, userId: existing.userId };
}

/** 全端末ログアウト・退会・再利用検知時に、該当ユーザーの有効な全Refresh Tokenを失効させる。 */
export async function revokeAllForUser(
  db: Db,
  userId: number,
  reason: "logout_all" | "reuse_detected" | "account_deleted"
): Promise<number> {
  const now = new Date().toISOString();
  const result = await db
    .update(refreshTokens)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  return result.length;
}

/** 単一端末ログアウト。冪等（既に失効済みでもエラーにしない）。 */
export async function revokeByDeviceId(db: Db, userId: number, deviceId: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(refreshTokens)
    .set({ revokedAt: now, revokedReason: "logout" })
    .where(
      and(eq(refreshTokens.userId, userId), eq(refreshTokens.deviceId, deviceId), isNull(refreshTokens.revokedAt))
    );
}
