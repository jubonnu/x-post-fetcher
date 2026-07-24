import { createClient } from "@libsql/client/web";
import { makeDb, type CreateDb } from "./client.ts";

/**
 * Cloudflare Workers（Edge）用 DB クライアント。
 * `@libsql/client/web` は fetch ベースで Node 専用モジュールを含まないため Workers で動作する。
 * ファイルURLは不可なので Turso の `libsql://...` URL + authToken が必須。
 */
export const createDb: CreateDb = (env) => {
  const url = env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is required in Workers runtime");
  return makeDb(createClient({ url, authToken: env.TURSO_AUTH_TOKEN }));
};
