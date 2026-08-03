import { eq } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/client.ts";
import { userIdentities, users, type UserIdentityRow, type UserRow } from "../db/schema.ts";
import { recordAuditLog } from "./auditLogRepository.ts";
import { issueRefreshToken } from "./refreshTokenRepository.ts";

export interface AppleSignInProfile {
  sub: string;
  email?: string;
  emailIsPrivateRelay?: boolean;
  /** Appleが初回認可時にのみ渡すfullName（Mobile-G4 Hardening）。 */
  displayName?: string;
}

export interface UserWithAppleIdentity {
  user: UserRow;
  identity: UserIdentityRow;
}

/** Apple `sub` からユーザーを照合する（`user_identities` 経由）。 */
export async function findUserByAppleSub(db: DbOrTx, sub: string): Promise<UserWithAppleIdentity | null> {
  const rows = await db
    .select({ user: users, identity: userIdentities })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId))
    .where(eq(userIdentities.providerUserId, sub));

  const match = rows.find((r) => r.identity.provider === "apple");
  return match ?? null;
}

export async function findUserByPublicUserId(db: DbOrTx, publicUserId: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.publicUserId, publicUserId));
  return rows[0] ?? null;
}

export async function findUserByInternalId(db: DbOrTx, id: number): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, id));
  return rows[0] ?? null;
}

export interface EncryptedAppleTokenValues {
  ciphertextBase64: string;
  ivBase64: string;
  keyVersion: string;
}

/**
 * DBエラーがUNIQUE制約違反（同一Apple subの同時初回ログイン等）かどうかを判定する。
 * `@libsql/client`（Node/HTTP/WebSocket共通）はSQLiteのエラーコードをそのまま伝播するため、
 * `SQLITE_CONSTRAINT`系のコードで判定する（メッセージ文言には依存しない）。
 */
export function isUniqueConstraintViolation(e: unknown): boolean {
  const code = (e as { code?: unknown; cause?: { code?: unknown } })?.code ?? (e as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}


export interface CreateUserAtomicParams {
  profile: AppleSignInProfile;
  encryptedAppleToken?: EncryptedAppleTokenValues;
  device: { deviceId: string; deviceName?: string };
  audit: { ipHash?: string; requestId?: string };
}

export interface CreateUserAtomicResult {
  user: UserRow;
  identity: UserIdentityRow;
  refreshToken: { raw: string };
}

/**
 * 初回Appleサインイン時のユーザー作成を原子的に行う（Mobile-G2A-Hardening）。
 * `users` INSERT・`user_identities` INSERT・初回Refresh Token INSERT・ログイン監査ログ
 * INSERTを**単一のDBトランザクション**（`db.transaction()`）で実行し、途中で失敗した場合は
 * 全件ロールバックする（孤立した`users`行等を残さない）。
 *
 * `@libsql/client`（Node/HTTP/WebSocket全ドライバ）はdrizzle-ormの`.transaction()`を
 * 実インタラクティブトランザクション（BEGIN/COMMIT/ROLLBACK）として実装しており、
 * Cloudflare Workers本番実行環境（`@libsql/client/web`）でも同様に動作する
 * （`node_modules/drizzle-orm/libsql/session.js`・`@libsql/client/lib-esm/http.js`で確認済み）。
 *
 * 同一Apple subでの同時初回ログイン（`user_identities`の`(provider, providerUserId)`
 * UNIQUE制約違反）の場合、このトランザクションは丸ごとロールバックされ例外を投げる。
 * 呼び出し側（`routes/auth.ts`）は`isUniqueConstraintViolation`で判定し、
 * 既存ユーザーとして再照会・ログイン継続する。
 *
 * ロック競合（`SQLITE_BUSY`）対策は接続時の`PRAGMA busy_timeout`（`db/client.node.ts`）に
 * 委ねる。アプリ側での再試行ループは、複数の同時リクエストが同じ遅延スケジュールで
 * 再試行し続け合う挙動を招くことが検証で判明したため、ここでは行わない。
 */
export async function createUserWithAppleIdentityAtomic(
  db: Db,
  params: CreateUserAtomicParams
): Promise<CreateUserAtomicResult> {
  return db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const publicUserId = crypto.randomUUID();

    const [user] = await tx
      .insert(users)
      .values({
        publicUserId,
        email: params.profile.email ?? null,
        emailIsPrivateRelay: params.profile.emailIsPrivateRelay ?? null,
        displayName: params.profile.displayName ?? null,
        accountStatus: "active",
        lastLoginAt: now,
      })
      .returning();

    const [identity] = await tx
      .insert(userIdentities)
      .values({
        userId: user.id,
        provider: "apple",
        providerUserId: params.profile.sub,
        email: params.profile.email ?? null,
        ...(params.encryptedAppleToken
          ? {
              appleRefreshTokenCiphertext: params.encryptedAppleToken.ciphertextBase64,
              appleRefreshTokenIv: params.encryptedAppleToken.ivBase64,
              appleRefreshTokenKeyVersion: params.encryptedAppleToken.keyVersion,
              appleTokenObtainedAt: now,
            }
          : {}),
      })
      .returning();

    const refreshToken = await issueRefreshToken(tx, {
      userId: user.id,
      deviceId: params.device.deviceId,
      deviceName: params.device.deviceName,
    });

    await recordAuditLog(tx, {
      userId: user.id,
      action: "login",
      detail: { provider: "apple", deviceId: params.device.deviceId },
      ipHash: params.audit.ipHash,
      requestId: params.audit.requestId,
    });

    return { user, identity, refreshToken: { raw: refreshToken.raw } };
  });
}

/**
 * 既存ユーザーの再ログイン時の更新。
 * Appleはemail/nameを初回サインイン時にしか返さないことがあるため、
 * 今回の値がnull/undefinedの項目は既存値を消さない（上書きしない）。
 */
export async function touchUserOnAppleLogin(
  db: Db,
  params: { userId: number; identityId: number; profile: AppleSignInProfile }
): Promise<void> {
  const { userId, identityId, profile } = params;
  const now = new Date().toISOString();

  const userUpdate: Partial<typeof users.$inferInsert> = { lastLoginAt: now, updatedAt: now };
  if (profile.email !== undefined) userUpdate.email = profile.email;
  if (profile.emailIsPrivateRelay !== undefined) userUpdate.emailIsPrivateRelay = profile.emailIsPrivateRelay;
  // displayNameは呼び出し側（routes/auth.ts）が「現在未設定の場合のみ」渡す（既存値を上書きしない）。
  if (profile.displayName !== undefined) userUpdate.displayName = profile.displayName;
  await db.update(users).set(userUpdate).where(eq(users.id, userId));

  const identityUpdate: Partial<typeof userIdentities.$inferInsert> = {};
  if (profile.email !== undefined) identityUpdate.email = profile.email;
  if (Object.keys(identityUpdate).length > 0) {
    await db.update(userIdentities).set(identityUpdate).where(eq(userIdentities.id, identityId));
  }
}

/**
 * authorizationCode交換で得たApple Refresh Tokenの暗号文を保存する（Mobile-G2A-Hardening）。
 * ベストエフォート機能のため、呼び出し側で交換が成功した場合のみ呼ばれる。
 */
export async function storeEncryptedAppleRefreshToken(
  db: Db,
  params: { identityId: number; ciphertextBase64: string; ivBase64: string; keyVersion: string }
): Promise<void> {
  await db
    .update(userIdentities)
    .set({
      appleRefreshTokenCiphertext: params.ciphertextBase64,
      appleRefreshTokenIv: params.ivBase64,
      appleRefreshTokenKeyVersion: params.keyVersion,
      appleTokenObtainedAt: new Date().toISOString(),
    })
    .where(eq(userIdentities.id, params.identityId));
}

/** ユーザーのApple identity行を取得する（Refresh Token失効処理用）。 */
export async function findAppleIdentityByUserId(db: Db, userId: number): Promise<UserIdentityRow | null> {
  const rows = await db
    .select()
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId));
  return rows.find((r) => r.provider === "apple") ?? null;
}
