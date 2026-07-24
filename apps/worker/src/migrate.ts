import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "./db/client.node.ts";

/**
 * マイグレーション適用。`npm run db:migrate -w @x-post/worker` で実行。
 * cwd（apps/worker）の ./migrations を対象にする。
 */
const db = createDb({
  TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
  TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
});

await migrate(db, { migrationsFolder: "./migrations" });
console.log("[migrate] 完了:", process.env.TURSO_DATABASE_URL ?? "file:local.db");
