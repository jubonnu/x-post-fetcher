import { chromium } from "playwright";
import { AUTH_STATE } from "./paths.ts";

/**
 * ログイン補助スクリプト（npm run login）
 *
 * 画面付きブラウザを起動し、開いた X のログイン画面で「あなた自身が」手動でログインする。
 * ログイン完了（auth_token クッキー検出）を自動検知したらセッションを auth.json に保存する。
 *
 * ※ パスワードはブラウザに直接入力するだけで、このスクリプトやログには残らない。
 * ※ auth.json はセッション情報そのもの。絶対にコミット・共有しないこと（.gitignore 済み）。
 * ※ 凍結リスクを避けるため、メインではなく専用（捨て）アカウントを使うこと。
 */

const LOGIN_URL = "https://x.com/login";
const WAIT_LIMIT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log("[login] ブラウザを起動します。開いた画面でXにログインしてください。");
  console.log("[login] （2段階認証がある場合もこの画面で入力してください）");

  // X はログイン画面で自動化ブラウザを検知して無反応にすることがある。
  // 本物の Chrome を使い automation フラグを隠すことで検知されにくくする。
  const launchOpts = {
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  };
  let browser;
  try {
    browser = await chromium.launch({ ...launchOpts, channel: "chrome" });
    console.log("[login] Google Chrome で起動しました。");
  } catch {
    browser = await chromium.launch(launchOpts);
    console.log("[login] Chromium で起動しました。");
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "ja-JP",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  console.log("[login] ログイン完了を待っています... (最大10分)");
  console.log("[login] ※ ログインが終わるまでブラウザのウィンドウは閉じないでください。");

  const deadline = Date.now() + WAIT_LIMIT_MS;
  let loggedIn = false;
  while (Date.now() < deadline) {
    if (!browser.isConnected()) {
      console.error("[login] ブラウザが閉じられました。もう一度 `npm run login` を実行してください。");
      process.exit(1);
    }
    const cookies = await context.cookies().catch(() => []);
    if (cookies.some((c) => c.name === "auth_token" && c.value)) {
      loggedIn = true;
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!loggedIn) {
    console.error("[login] タイムアウト。ログインが完了しませんでした。もう一度お試しください。");
    await browser.close().catch(() => {});
    process.exit(1);
  }

  await context.storageState({ path: AUTH_STATE });
  console.log(`[login] ログイン成功。セッションを保存しました: ${AUTH_STATE}`);
  console.log("[login] 以降 `npm run fetch` はこのログイン状態で実行されます。");

  await browser.close();
}

main().catch((err) => {
  console.error("[login][error]", err instanceof Error ? err.message : err);
  process.exit(1);
});
