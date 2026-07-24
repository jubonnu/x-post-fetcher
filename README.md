# x-post-fetcher

Playwright で Xアカウント [@Zabi_pokeka](https://x.com/Zabi_pokeka) の投稿を取得し、抽選情報として蓄積するシステム。
実装計画は [`docs/implementation-plan.md`](docs/implementation-plan.md) を参照。

## 構成（npm workspaces モノレポ）

```
packages/shared   … 型・Zodスキーマ・utils（Node/Workers 共用）
apps/scraper      … Playwright取得＋生データ抽出＋取込ジョブ（GitHub Actions/Node）
apps/worker       … Hono + Drizzle + libSQL、内部取込API /ingest（Cloudflare Workers）
```

---

## Phase 1（現状: 保存層 + 生データ抽出）

`GitHub Actions → Playwright → (Claude) → Cloudflare Workers → Turso` のうち、**Phase 1 は保存層と生データ抽出まで**。
Claude 解析・分類・抽選抽出・同一判定・履歴統合・URL解決は **Phase 2 以降（未実装）**。

### 主要コマンド

```bash
npm install
npx playwright install chromium

# ローカルDB（libSQL ファイル）を用意
TURSO_DATABASE_URL=file:local.db npm run db:migrate -w @x-post/worker

# Worker をローカル起動（別ターミナル）
INGEST_TOKEN=dev-secret TURSO_DATABASE_URL=file:local.db npm run worker:dev

# 取得 → /ingest へ登録
INGEST_URL=http://localhost:8787/ingest INGEST_TOKEN=dev-secret npm run scrape

# 取得のみ（DB送信なし・従来CLI）: npm run login / npm run fetch
# テスト: npm test   /  型チェック: npm run typecheck
```

### Cloudflare Workers 本番用 DB クライアント（Edge対応）

- Worker エントリ（`apps/worker/src/index.ts`）は **`@libsql/client/web`**（fetch ベース）を使う。
  Node 専用モジュールを含まないため Workers バンドルで動作する（`wrangler deploy --dry-run` で確認済み）。
- Node 実行（ローカル/CI/マイグレーション）は **`@libsql/client`**（`client.node.ts`）を使う。
  `createApp(createDb)` に生成関数を注入することで両ランタイムを切替。
- **本番 env（Secrets）の読み込み**: Workers では `c.env`、Node では `process.env` から解決する。
  - `TURSO_DATABASE_URL` … `libsql://<db>.turso.io`
  - `TURSO_AUTH_TOKEN`   … Turso のトークン
  - `INGEST_TOKEN`       … /ingest の Bearer トークン
  - 登録: `wrangler secret put TURSO_DATABASE_URL`（他も同様）。ローカルは `.env`/環境変数。

### 既知の制約（Phase 1）

- **authorId**: React DOM（ログイン時）では数値IDを確実に取得できず **null** になる。
  `authorUsername` / `authorDisplayName` / `sourceUrl` は取得済み。単一アカウント監視では authorId 欠落の影響は小さい。
  → authorId の改善は **Phase 2 以降の低優先度 TODO**（例: プロフィールAPI/別経路で補完）。
- **imageUrls（画像URLの扱い）**:
  - **画像バイナリはダウンロードしない**（要件維持）。画像リクエストは 1×1 スタブで `fulfill` し、
    本物のバイナリを取得せずに X が DOM へ書き込む **画像URL（メタデータ）だけ**を拾う。
    （`abort` だと X が背景画像URLをDOMに書かないため、スタブ fulfill にしている）
  - 抽出元の優先順: `img[src*="pbs.twimg.com/media"]` → `img[srcset]` → `source[srcset]` →
    SSR `meta[itemprop="image"]` → `background-image: url(...)`。
  - `pbs.twimg.com/media` のみ対象（アバター=`profile_images` / 絵文字=`abs.twimg.com/emoji` は除外）。
  - URLは **元サイズ `name=orig` に正規化**して size 違いを重複排除（`?format=...&name=orig`）。
  - imageUrls が空でも投稿保存は成功。画像抽出失敗で **バッチ全体は停止しない**。
  - **rawHtml は画像URLタグを含み、cleanedHtml は画像を除去**（保存方針を維持）。

### 安全性

- `auth.json`（ログインセッション）・`*.db`（ローカルDB）・`.env` は `.gitignore` 済み（Git管理外）。
- GitHub Actions では `auth.json` を **Base64 Secret から一時復元 → `always()` で削除**、
  失敗時 Artifact の収集対象から **認証ファイルを除外**（`.github/workflows/scrape.yml`）。
- 保存する HTML は対象 `article` 要素のみで、Cookie/storage state は含めない。

---

## （参考）PoC 時の取得ノウハウ

## できること

- 対象アカウントのプロフィールへアクセス
- 最新 N 件の投稿を取得（投稿ID / 投稿日時 / 本文 / URL）— 件数は `MAX_POSTS` で調整
- Console へ整形表示
- 各投稿の HTML を `./output/post-<id>.html` に保存
- 投稿一覧を `./output/posts.json` に保存

## セットアップ

```bash
npm install
npx playwright install chromium
```

## 実行

```bash
npm run fetch
```

## ログイン取得（連続した最新 N 件が欲しい場合）

未ログインだと X は「間引かれた十数件」しか返さない（連続した最新投稿にならない）。
連続した最新 N 件を取るにはログインが必要。

```bash
npm run login   # ブラウザが開くので自分で X にログイン → セッションが auth.json に保存される
npm run fetch   # 以降 auth.json があればログイン状態で実行され、スクロールで連続取得する
```

- `npm run login` は画面付きブラウザを起動する。**パスワードはブラウザに直接入力**するだけで、
  スクリプトやログには残らない。ログイン完了（`auth_token` クッキー検出）を自動検知して
  `./auth.json` に保存する。
- **注意**: ログイン状態での自動取得は X の利用規約に抵触し、アカウント凍結・レート制限のリスクがある。
  必ず**メインではなく専用（捨て）アカウント**を使うこと。`auth.json` は絶対にコミット・共有しない
  （`.gitignore` 済み）。
- 取得件数は `src/index.ts` の `MAX_POSTS` で変更する。

## 技術メモ（検証で分かったこと）

- **X はアクセス元の User-Agent によって、Schema.org 構造化データ付きの SSR ページを返す。**
  ブラウザ相当の UA を渡すと、各投稿が
  `<article data-tweet-id="..." itemtype="https://schema.org/SocialMediaPosting">` として描画され、
  直下の `<meta itemprop="...">` に ID / 日時（`datePublished`）/ URL / 本文（`articleBody`）が入る。
  React DOM（`data-testid="tweet"`）よりこちらの方が堅牢に抽出できるため、本 PoC はこの構造を利用している。
- **長文投稿の本文は `meta[itemprop="articleBody"]` では先頭 ~229 文字に切り詰められる。**
  全文はタイムライン上で「さらに表示」ボタン（`<button onclick>`、その場で展開／ページ遷移なし）を
  押すと `<div dir="auto">` に描画される。そこで抽出前に全ての「さらに表示」を押して展開している。
  個別投稿ページを1件ずつ開く方法より、タイムライン1ページで済みリクエスト数が少ない（レート制限に強い）。
- **「さらに表示」のクリックは `page.evaluate` 内で `button.click()` を直接呼ぶ。**
  Playwright の `locator.click()` はアクション可能性チェックのため、画像と重なる長文投稿等で
  クリックが弾かれることがあるため。
- **本文全文の特定は「指紋照合」で行う。** 切り詰められた `articleBody`（抜粋）の先頭を指紋にし、
  それで始まる `<div dir="auto">` を本文全文とみなす（著者名や日時の div との誤認を防ぐ）。
- **ログイン不要でプロフィール投稿を取得できた。** ただし将来ログイン必須に変わった場合に備え、
  ログイン済みの `storageState` を `./auth.json` に置くと自動で読み込む実装にしてある。
  （生成例: `npx playwright open --save-storage=auth.json https://x.com/login` でログイン後に閉じる）
- **実行は tsx ではなく Node 24 のネイティブ型ストリッピング（`node src/index.ts`）を使用。**
  tsx(esbuild) は `page.$$eval` に渡すブラウザ内コールバックへ `__name` ヘルパーを注入し、
  ブラウザ側で `ReferenceError: __name is not defined` を起こすため。

## 制約

- SSR ページが返す投稿件数（十数件程度）の範囲で「日時の新しい順」に上位5件を採用する。
- 本文中の URL は表示用の短縮形（例: `apps.apple.com/jp/app/…` と末尾が `…` で省略）で取得される。
  実リンクが必要な場合は、本文 div 内の `<a>` の `href`（t.co リンク）から展開する処理を追加する必要がある。
- X 側の仕様変更・レート制限で構造が変わると取得できなくなる可能性がある（PoC のため）。
