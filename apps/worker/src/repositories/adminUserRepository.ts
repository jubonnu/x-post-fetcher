import { eq } from "drizzle-orm";
import type { DbOrTx } from "../db/client.ts";
import { adminUsers, type AdminUserRow } from "../db/schema.ts";

export async function findAdminUserByEmail(db: DbOrTx, email: string): Promise<AdminUserRow | null> {
  const rows = await db.select().from(adminUsers).where(eq(adminUsers.email, email));
  return rows[0] ?? null;
}

export async function findAdminUserById(db: DbOrTx, id: number): Promise<AdminUserRow | null> {
  const rows = await db.select().from(adminUsers).where(eq(adminUsers.id, id));
  return rows[0] ?? null;
}

export async function createAdminUser(db: DbOrTx, params: { email: string; passwordHash: string }): Promise<AdminUserRow> {
  const [row] = await db.insert(adminUsers).values({ email: params.email, passwordHash: params.passwordHash }).returning();
  return row;
}

export async function updateAdminUserPassword(db: DbOrTx, id: number, passwordHash: string): Promise<void> {
  await db.update(adminUsers).set({ passwordHash, updatedAt: new Date().toISOString() }).where(eq(adminUsers.id, id));
}
