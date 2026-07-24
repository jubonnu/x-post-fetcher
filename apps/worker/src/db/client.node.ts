import { createClient } from "@libsql/client";
import { makeDb, type CreateDb } from "./client.ts";

/**
 * Node 用 DB クライアント（ローカル/CI/マイグレーション）。
 * ファイルURL（file:local.db）と Turso（libsql://）の両方に対応。
 */
export const createDb: CreateDb = (env) => {
  const url = env.TURSO_DATABASE_URL ?? "file:local.db";
  return makeDb(createClient({ url, authToken: env.TURSO_AUTH_TOKEN }));
};
