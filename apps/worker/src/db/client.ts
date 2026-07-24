import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import * as schema from "./schema.ts";

export interface DbEnv {
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
}

/**
 * libSQL Client を Drizzle でラップする（ランタイム非依存）。
 * ※ ここでは `@libsql/client` を **型のみ** import（実体は import しない）。
 *   実クライアントの生成は client.node.ts（Node）/ client.web.ts（Edge）で分ける。
 *   これにより Workers バンドルへ Node 専用モジュールが混入しない。
 */
export function makeDb(client: Client) {
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof makeDb>;
export type CreateDb = (env: DbEnv) => Db;
