import { createApp } from "./app.ts";
import { createDb } from "./db/client.web.ts";

/**
 * Cloudflare Workers エントリ（Edge）。
 * DB は @libsql/client/web（fetch ベース）を使用し、Node 専用モジュールを含まない。
 * 必要な env（Secrets）: INGEST_TOKEN / TURSO_DATABASE_URL / TURSO_AUTH_TOKEN
 */
const app = createApp(createDb);
export default app;
