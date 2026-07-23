import { chromium } from "playwright";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ログイン補助スクリプト（npm run login）
 *
 * ブラウザ（Chromium）を画面付きで起動する。開いた X のログイン画面で
 * 「あなた自身が」手動でログインする（2段階認証もこの画面で完了させる）。
 * ログイン完了（auth_token クッキー検出）を自動検知したら、そのセッションを
 * ./auth.json（Playwright storageState）に保存して終了する。
 *
 * ※ パスワードはブラウザに直接入力するだけで、このスクリプトやログには残らない。
 * ※ auth.json はセッション情報そのもの。絶対にコミット・共有しないこと（.gitignore 済み）。
 * ※ 凍結リスクを避けるため、メインではなく専用（捨て）アカウントを使うこと。
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const AUTH_STATE = resolve(ROOT, "auth.json");

const LOGIN_URL = "https://x.com/login";
const WAIT_LIMIT_MS = 10 * 60 * 1000; // ログイン完了を待つ上限（10分）
const POLL_INTERVAL_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log("[login] ブラウザを起動します。開いた画面でXにログインしてください。");
  console.log("[login] （2段階認証がある場合もこの画面で入力してください）");

  // X はログイン画面で自動化ブラウザを検知し、操作を無反応にすることがある。
  // 検知されにくくするため (1)本物の Chrome を使う (2)automation フラグを隠す。
  const launchOpts = {
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  };
  let browser;
  try {
    // 実物の Google Chrome があればそれを使う（バンドル版 Chromium より検知されにくい）
    browser = await chromium.launch({ ...launchOpts, channel: "chrome" });
    console.log("[login] Google Chrome で起動しました。");
  } catch {
    // Chrome が無ければバンドル版 Chromium にフォールバック
    browser = await chromium.launch(launchOpts);
    console.log("[login] Chromium で起動しました。");
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "ja-JP",
  });
  // navigator.webdriver を隠す（自動化検知の代表的なシグナルを消す）
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
    // ウィンドウを閉じられた場合など、ブラウザが切断されていたら中断
    if (!browser.isConnected()) {
      console.error(
        "[login] ブラウザが閉じられました。ログイン完了前にウィンドウを閉じないでください。もう一度 `npm run login` を実行してください。"
      );
      process.exit(1);
    }

    // ログイン成功すると auth_token クッキーが発行される
    // （ブラウザ操作に依存しない Node 側 sleep を使い、ウィンドウ操作で落ちないようにする）
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

  // セッション（クッキー・localStorage）を保存
  await context.storageState({ path: AUTH_STATE });
  console.log(`[login] ログイン成功。セッションを保存しました: ${AUTH_STATE}`);
  console.log("[login] 以降 `npm run fetch` はこのログイン状態で実行されます。");

  await browser.close();
}

main().catch((err) => {
  console.error("[login][error]", err instanceof Error ? err.message : err);
  process.exit(1);
});
