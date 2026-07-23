# x-post-fetcher (PoC)

Playwright で Xアカウント [@Zabi_pokeka](https://x.com/Zabi_pokeka) の最新投稿を取得する技術検証。
ポケモンカードの抽選・予約・再販情報を自動取得するシステムの土台。

## できること

- 対象アカウントのプロフィールへアクセス
- 最新5件の投稿を取得（投稿ID / 投稿日時 / 本文 / URL）
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
