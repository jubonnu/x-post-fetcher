import type { Env } from "../env.ts";

export class AdminAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminAuthConfigError";
  }
}

export interface AdminAuthRuntimeConfig {
  inviteCode: string;
  jwtSecret: string;
}

/** `ADMIN_INVITE_CODE`・`ADMIN_JWT_SECRET`のいずれか未設定ならfail-closedにする。 */
export function resolveAdminAuthConfig(env: Env): AdminAuthRuntimeConfig {
  if (!env.ADMIN_INVITE_CODE) throw new AdminAuthConfigError("ADMIN_INVITE_CODEが未設定です");
  if (!env.ADMIN_JWT_SECRET) throw new AdminAuthConfigError("ADMIN_JWT_SECRETが未設定です");
  return { inviteCode: env.ADMIN_INVITE_CODE, jwtSecret: env.ADMIN_JWT_SECRET };
}
