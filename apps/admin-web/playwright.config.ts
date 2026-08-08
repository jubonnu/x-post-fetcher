import { defineConfig, devices } from "@playwright/test";

/**
 * 管理画面のE2Eスモークテスト。
 *
 * staging/production環境には一切触れず、完全に隔離されたローカル環境で完結させる:
 * - worker: `apps/worker`をローカルNodeサーバーとして起動し、実行毎に使い捨ての
 *   SQLiteファイル（e2e-test.db）へマイグレーションを適用してから起動する
 *   （`e2e:server`スクリプト、招待コード・JWT鍵はテスト専用のダミー値）。
 * - admin-web: Viteの開発サーバーを、上記ローカルworkerを指すVITE_API_BASE_URLで起動する。
 */
const WORKER_PORT = 8799;
const WEB_PORT = 5188;

export const E2E_INVITE_CODE = "e2e-test-invite-code";
export const E2E_INGEST_TOKEN = "e2e-test-ingest-token";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm run e2e:server",
      cwd: "../worker",
      url: `http://localhost:${WORKER_PORT}/`,
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: String(WORKER_PORT),
        TURSO_DATABASE_URL: "file:./e2e-test.db",
        ADMIN_INVITE_CODE: E2E_INVITE_CODE,
        ADMIN_JWT_SECRET: "e2e-test-jwt-secret",
        ADMIN_WEB_ORIGINS: `http://localhost:${WEB_PORT}`,
        E2E_SEED_ENABLED: "true",
        INGEST_TOKEN: E2E_INGEST_TOKEN,
      },
    },
    {
      command: `npm run dev -- --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}/`,
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
      env: {
        VITE_API_BASE_URL: `http://localhost:${WORKER_PORT}`,
      },
    },
  ],
});
