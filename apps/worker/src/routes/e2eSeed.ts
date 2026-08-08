import type { Hono } from "hono";
import { lotteries } from "../db/schema.ts";
import type { AppEnv } from "../env.ts";

/**
 * E2E（Playwright）テスト専用のデータ投入API。
 *
 * `E2E_SEED_ENABLED=true` を明示的に設定した環境（`apps/admin-web/playwright.config.ts`が
 * 起動するローカルworkerのみ）でのみ有効にする。staging/productionはこの環境変数を
 * 絶対に設定しないため、誤って公開されても404で無害化される（fail-closed）。
 * 本物の抽選データはAI解析パイプライン（/ingest）経由でしか作られないが、
 * E2Eではその複雑な入力を組み立てずに固定の1件を直接insertするだけで十分なため、
 * 本番コードパスとは別の最小限のテスト用エンドポイントとして用意する。
 */
export function registerE2eSeed(app: Hono<AppEnv>): void {
  app.post("/internal/e2e-seed", async (c) => {
    if (c.get("env").E2E_SEED_ENABLED !== "true") return c.notFound();

    const db = c.get("db");
    const [row] = await db
      .insert(lotteries)
      .values({
        productNameRaw: "E2Eテスト商品",
        normalizedProductName: "E2Eテスト商品",
        storeNameRaw: "E2Eテスト店舗",
        normalizedStoreName: "E2Eテスト店舗",
        cardType: "other",
        verificationStatus: "extracted",
        lifecycleStatus: "active",
      })
      .returning();

    return c.json({ ok: true, id: row.id });
  });
}
