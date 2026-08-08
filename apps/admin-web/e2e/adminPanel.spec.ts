import { expect, test, type Page } from "@playwright/test";
import { E2E_INGEST_TOKEN, E2E_INVITE_CODE } from "../playwright.config.ts";

const WORKER_URL = "http://localhost:8799";
const ADMIN_EMAIL = "e2e@example.com";
const ADMIN_PASSWORD = "e2e-password-123";

/**
 * 管理画面の主要フローを一気通貫で確認するスモークテスト。
 * サインアップ→ログイン→一覧→編集→承認/却下→パスワード変更→ログアウトの順に、
 * 実際のブラウザ操作でローカルworker（使い捨てDB）に対して行う。
 *
 * Playwrightは各`test()`ごとに独立したブラウザコンテキスト（localStorage等も別）を
 * 使うため、ログインセッションを引き継いだまま複数の`test()`に分けることはできない。
 * 1本の`test()`の中で`test.step()`により手順を区切り、レポート上の可読性を確保する。
 */
async function seedLottery(): Promise<number> {
  const res = await fetch(`${WORKER_URL}/internal/e2e-seed`, {
    method: "POST",
    headers: { Authorization: `Bearer ${E2E_INGEST_TOKEN}` },
  });
  if (!res.ok) throw new Error(`seed failed: ${res.status}`);
  const body = (await res.json()) as { id: number };
  return body.id;
}

async function fillLabeled(page: Page, label: string, value: string) {
  await page.getByLabel(label).fill(value);
}

test("管理画面スモークテスト: サインアップ〜編集〜承認〜パスワード変更〜ログアウト", async ({ page }) => {
  const lotteryId = await seedLottery();

  await test.step("招待コードでサインアップすると一覧画面へ遷移する", async () => {
    await page.goto("/signup");
    await fillLabeled(page, "メールアドレス", ADMIN_EMAIL);
    await fillLabeled(page, "パスワード（8文字以上）", ADMIN_PASSWORD);
    await fillLabeled(page, "招待コード", E2E_INVITE_CODE);
    await page.getByRole("button", { name: "登録" }).click();

    await expect(page.getByRole("heading", { name: "抽選一覧" })).toBeVisible();
    await expect(page.getByText(ADMIN_EMAIL)).toBeVisible();
  });

  await test.step("要確認タブにシード済みの抽選が表示される", async () => {
    await expect(page.getByText("E2Eテスト商品")).toBeVisible();
    await expect(page.getByText("E2Eテスト店舗")).toBeVisible();
  });

  await test.step("編集画面でタイトルを変更して保存できる", async () => {
    await page.goto(`/lotteries/${lotteryId}`);
    await expect(page.getByLabel("タイトル")).toHaveValue("E2Eテスト商品");

    await fillLabeled(page, "タイトル", "E2E編集後タイトル");
    await page.getByRole("button", { name: "保存" }).click();

    await expect(page.getByText("保存しました")).toBeVisible();
  });

  await test.step("承認すると一覧の承認済みタブに移動する", async () => {
    await page.getByRole("button", { name: "承認する" }).click();
    await expect(page.getByText("承認済み", { exact: true }).first()).toBeVisible();

    await page.goto("/");
    await page.getByRole("button", { name: "承認済み" }).click();
    await expect(page.getByText("E2E編集後タイトル")).toBeVisible();

    await page.getByRole("button", { name: "要確認" }).click();
    await expect(page.getByText("E2E編集後タイトル")).not.toBeVisible();
  });

  const newPassword = "e2e-new-password-456";
  await test.step("パスワード変更ができ、新しいパスワードで再ログインできる", async () => {
    await page.goto("/change-password");
    await fillLabeled(page, "現在のパスワード", ADMIN_PASSWORD);
    await fillLabeled(page, "新しいパスワード（8文字以上）", newPassword);
    await page.getByRole("button", { name: "変更する" }).click();
    await expect(page.getByText("パスワードを変更しました")).toBeVisible();

    await page.goto("/");
    await page.getByRole("button", { name: "ログアウト" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await fillLabeled(page, "メールアドレス", ADMIN_EMAIL);
    await fillLabeled(page, "パスワード", newPassword);
    await page.getByRole("button", { name: "ログイン" }).click();
    await expect(page.getByRole("heading", { name: "抽選一覧" })).toBeVisible();
  });

  await test.step("ログアウトするとログイン画面に戻る", async () => {
    await page.getByRole("button", { name: "ログアウト" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "ログイン" })).toBeVisible();
  });
});
