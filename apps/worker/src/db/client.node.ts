import { createClient } from "@libsql/client";
import { makeDb, type CreateDb } from "./client.ts";

/**
 * Node 用 DB クライアント（ローカル/CI/マイグレーション）。
 * ファイルURL（file:local.db）と Turso（libsql://）の両方に対応。
 *
 * `busy_timeout`設定（Mobile-G2A残修正）: `file:`ローカルSQLiteは、このアプリの構成上
 * リクエストごとに新しい接続を作るため、同時書き込み（同一Apple subの同時初回ログイン等）で
 * `SQLITE_BUSY`が即座に返ってしまう（デフォルトはbusy_timeout=0）。`PRAGMA busy_timeout`を
 * 設定し、ロック解放を一定時間待ってから再試行するSQLite自身の機能を有効にする
 * （アプリ側の`db/retry.ts`によるリトライと合わせた二重の対策）。
 */
export const createDb: CreateDb = (env) => {
  const url = env.TURSO_DATABASE_URL ?? "file:local.db";
  const client = createClient({ url, authToken: env.TURSO_AUTH_TOKEN });
  void client.execute("PRAGMA busy_timeout = 3000").catch(() => undefined);
  return makeDb(client);
};
