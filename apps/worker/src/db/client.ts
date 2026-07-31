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

/**
 * `db.transaction(async (tx) => ...)` のコールバック引数の型。
 * リポジトリ関数を `db`（通常時）・`tx`（トランザクション内）の両方から呼べるようにするため、
 * `DbOrTx` を関数シグネチャに使う（Mobile-G2A-Hardening: 新規ユーザー作成の原子化）。
 * `@libsql/client`（Node/HTTP・WebSocket双方）はdrizzle-ormの`.transaction()`を
 * 実インタラクティブトランザクション（BEGIN/COMMIT/ROLLBACK）として実装しており、
 * Cloudflare Workers（`@libsql/client/web`）でも同様に動作する。
 */
export type Tx = Parameters<Db["transaction"]>[0] extends (tx: infer T, ...rest: unknown[]) => unknown ? T : never;
export type DbOrTx = Db | Tx;
