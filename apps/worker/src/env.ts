import type { Db, DbEnv } from "./db/client.ts";

/** Worker が参照する環境変数（Workers Bindings / Node process.env） */
export interface Env extends DbEnv {
  /** /ingest の Bearer トークン */
  INGEST_TOKEN?: string;
}

export type Variables = {
  db: Db;
  env: Env;
};

export type AppEnv = { Bindings: Env; Variables: Variables };
