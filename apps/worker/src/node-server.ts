import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createDb } from "./db/client.node.ts";

/**
 * ローカル/CI 用の Node サーバー。
 * env は process.env（TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, INGEST_TOKEN, PORT）から解決。
 */
const app = createApp(createDb);
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[worker] listening on http://localhost:${info.port}`);
  console.log(`[worker] DB: ${process.env.TURSO_DATABASE_URL ?? "file:local.db"}`);
  if (!process.env.INGEST_TOKEN) {
    console.warn("[worker] 警告: INGEST_TOKEN 未設定のため /ingest は全て 401 になります。");
  }
});
