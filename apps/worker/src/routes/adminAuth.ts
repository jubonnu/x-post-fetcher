import type { Hono } from "hono";
import { adminChangePasswordRequestSchema, adminLoginRequestSchema, adminSignupRequestSchema } from "../adminAuth/schemas.ts";
import { requireAdminAuth } from "../adminAuth/middleware.ts";
import { hashPassword, verifyPassword } from "../adminAuth/password.ts";
import { signAdminToken } from "../adminAuth/token.ts";
import { ApiError, apiErrorJson } from "../auth/errors.ts";
import {
  createAdminUser,
  findAdminUserByEmail,
  findAdminUserById,
  updateAdminUserPassword,
} from "../repositories/adminUserRepository.ts";
import { isUniqueConstraintViolation } from "../repositories/userRepository.ts";
import type { AppEnv } from "../env.ts";
import type { AdminUserRow } from "../db/schema.ts";

function toAdminUserResponse(admin: AdminUserRow) {
  return { id: admin.id, email: admin.email, createdAt: admin.createdAt };
}

async function parseJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/**
 * 管理画面（Phase 7）専用の認証API。モバイル向け`/auth/*`（Sign in with Apple）とは
 * 完全に別系統——メール+パスワード、招待コード方式のサインアップ、メール確認は行わない。
 * `/admin/*`全体に`requireAdminAuthConfigured`が適用済みの前提（`app.ts`側）。
 */
export function registerAdminAuth(app: Hono<AppEnv>): void {
  app.post("/admin/auth/signup", async (c) => {
    const body = await parseJsonBody(c);
    if (body === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストボディが不正です"));

    const parsed = adminSignupRequestSchema.safeParse(body);
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));

    const { inviteCode } = c.get("adminAuthConfig")!;
    if (parsed.data.inviteCode !== inviteCode) {
      return apiErrorJson(c, new ApiError("FORBIDDEN", "招待コードが正しくありません"));
    }

    const db = c.get("db");
    const passwordHash = await hashPassword(parsed.data.password);

    let admin: AdminUserRow;
    try {
      admin = await createAdminUser(db, { email: parsed.data.email, passwordHash });
    } catch (e) {
      if (isUniqueConstraintViolation(e)) {
        return apiErrorJson(c, new ApiError("CONFLICT", "このメールアドレスは既に登録されています"));
      }
      throw e;
    }

    const { jwtSecret } = c.get("adminAuthConfig")!;
    const token = await signAdminToken({ adminUserId: admin.id, secret: jwtSecret });
    return c.json({ token, admin: toAdminUserResponse(admin) }, 201);
  });

  app.post("/admin/auth/login", async (c) => {
    const body = await parseJsonBody(c);
    if (body === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストボディが不正です"));

    const parsed = adminLoginRequestSchema.safeParse(body);
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));

    const db = c.get("db");
    const admin = await findAdminUserByEmail(db, parsed.data.email);
    // メールアドレスが存在するかどうかで応答を変えない（列挙攻撃対策のため、常に同じエラーにする）。
    const passwordOk = admin ? await verifyPassword(parsed.data.password, admin.passwordHash) : false;
    if (!admin || !passwordOk) {
      return apiErrorJson(c, new ApiError("UNAUTHORIZED", "メールアドレスまたはパスワードが正しくありません"));
    }

    const { jwtSecret } = c.get("adminAuthConfig")!;
    const token = await signAdminToken({ adminUserId: admin.id, secret: jwtSecret });
    return c.json({ token, admin: toAdminUserResponse(admin) });
  });

  app.get("/admin/auth/me", requireAdminAuth, async (c) => {
    const db = c.get("db");
    const admin = await findAdminUserById(db, c.get("adminUserId")!);
    if (!admin) return apiErrorJson(c, new ApiError("UNAUTHORIZED", "管理者アカウントが見つかりません"));
    return c.json({ admin: toAdminUserResponse(admin) });
  });

  app.post("/admin/auth/change-password", requireAdminAuth, async (c) => {
    const body = await parseJsonBody(c);
    if (body === null) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストボディが不正です"));

    const parsed = adminChangePasswordRequestSchema.safeParse(body);
    if (!parsed.success) return apiErrorJson(c, new ApiError("VALIDATION_ERROR", "リクエストの形式が不正です"));

    const db = c.get("db");
    const admin = await findAdminUserById(db, c.get("adminUserId")!);
    if (!admin) return apiErrorJson(c, new ApiError("UNAUTHORIZED", "管理者アカウントが見つかりません"));

    const currentOk = await verifyPassword(parsed.data.currentPassword, admin.passwordHash);
    if (!currentOk) return apiErrorJson(c, new ApiError("UNAUTHORIZED", "現在のパスワードが正しくありません"));

    const newHash = await hashPassword(parsed.data.newPassword);
    await updateAdminUserPassword(db, admin.id, newHash);
    return c.json({ ok: true });
  });
}
