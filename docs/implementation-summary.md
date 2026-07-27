# 実装サマリー: X投稿 → 抽選情報 解析・DB登録システム

Phase 1〜5 の実装内容をまとめたドキュメント。  
コミット: `a8dd4cc` → `ba4c342`（main ブランチ）

---

## システム概要

```
GitHub Actions (cron)          Cloudflare Workers             Turso (libSQL)
┌────────────────────────┐    POST /ingest               ┌──────────────────┐
│ Playwright でX投稿取得  │  ──────────────────────────▶  │ source_posts     │
│ ルールで抽選情報解析    │    Bearer 認証               │ post_analyses    │
│ payload を /ingest へ  │  ◀──────────────────────────  │ lotteries        │
└────────────────────────┘    構造化JSONレスポンス       │ lottery_sources  │
                                                         │ lottery_field_history │
            GET /lotteries（公開）                       │ processing_jobs  │
            /internal/*（管理・認証必須）                └──────────────────┘
            /internal/jobs/process（URL解決）
```

**方針（全フェーズ共通）**
- 解析は **100% ルールベース**。LLM / Anthropic SDK は使用しない。
- `auth.json` はコミット禁止（Base64 で GitHub Secrets に保存、実行時に一時復元）
- `.env` / `*.db` / rawHtml 全文 / Cookie をログ・Git に出さない
- Scraper はデータ抽出と提案のみ。統合・確定・永続化は Worker の責務。

---

## 技術スタック

| 区分 | 採用技術 |
|------|----------|
| モノレポ | npm workspaces（packages/shared / apps/scraper / apps/worker） |
| スクレイピング | Playwright（Node.js、GitHub Actions 上で実行） |
| API サーバー | Hono（Cloudflare Workers） |
| ORM | Drizzle ORM |
| DB | Turso（libSQL / SQLite 互換） |
| スキーマ検証 | Zod（packages/shared に置き、scraper / worker で共用） |
| テスト | Vitest |

---

## リポジトリ構成

```
packages/shared/
  src/types.ts          # 共通型（PostType, CardType, DatePrecision 等）
  src/schemas.ts        # Zod スキーマ（IngestPayload / AnalysisInput 等）
  src/utils/date.ts     # 日時正規化・年推定・曜日整合
  src/utils/url.ts      # URL分類・ドメイン抽出
  src/utils/hash.ts     # contentHash（SHA-256）
  tests/                # 21 件

apps/scraper/
  src/scraping/x/       # Playwright での取得（fetchTweets / parseTweetDom）
  src/lottery/          # ルールベース解析（classify / extract / splitLotteries）
  src/jobs/fetchAndProcessTweets.ts  # オーケストレーション → /ingest へ POST
  tests/                # 27 件

apps/worker/
  src/db/schema.ts      # Drizzle スキーマ（6テーブル）
  src/repositories/     # sourcePost / analysis / lottery / processingJob
  src/services/         # normalize / matchExistingLottery / mergeLotteryData
                        # resolveUrl / updateLotteryUrls
  src/routes/           # ingest / lotteries / jobs / review
  migrations/           # 0000〜0006（7ファイル）
  tests/                # 70 件
```

---

## DBテーブル一覧

| テーブル | 追加フェーズ | 主な用途 |
|----------|------------|----------|
| `source_posts` | Phase 1 | X 投稿の生データ保存 |
| `post_analyses` | Phase 2 | ルールベース解析結果（parserVersion / contentHash） |
| `lotteries` | Phase 2 | 抽選本体（正規化前 Raw 値と正規化後を両方保持） |
| `lottery_sources` | Phase 3 | 1抽選に寄与した投稿の記録（matchAction / score） |
| `lottery_field_history` | Phase 3 | フィールドごとの変更履歴（created / updated / conflicting） |
| `processing_jobs` | Phase 4 | 非同期ジョブ管理（URL解決・再解析） |

---

## Phase 1 — モノレポ化 + 保存層 + 生データ抽出

**コミット:** `a8dd4cc`

### 実装内容

- npm workspaces でモノレポ化（packages/shared / apps/scraper / apps/worker）
- **packages/shared**: 共通型（PostType / CardType / DatePrecision）、Zod スキーマ（IngestPayload）、`computeContentHash`（SHA-256）、URL 分類ユーティリティ
- **apps/worker**:
  - Drizzle ORM + Turso（libSQL）セットアップ
  - `source_posts` テーブル（migration 0000）、`externalPostId` に UNIQUE 制約
  - `POST /ingest`（Hono、Bearer 認証）— `externalPostId` upsert + `contentHash` 重複回避
  - upsert アクション: `inserted` / `updated`（本文変更） / `unchanged`（同一）
- **apps/scraper**:
  - 既存取得コードを `scraping/x/` に分解（fetchTweets / parseTweetDom / selectors）
  - 生データ（tweetId / authorId / publishedAt / bodyText / externalUrls / imageUrls / rawHtml / contentHash）を構築して `/ingest` へ POST
- `.github/workflows/scrape.yml`（cron 最短5分 / workflow_dispatch / concurrency / auth.json を Base64 Secret から一時復元）

### マイグレーション

```sql
-- 0000: source_posts
CREATE TABLE source_posts (id, platform, external_post_id UNIQUE, author_*, body_raw,
  published_at, source_url, image_urls, external_urls, raw_html, cleaned_html,
  content_hash, fetched_at, deleted_at, created_at, updated_at);
```

---

## Phase 2 — ルールベース解析 + 保存・再解析（LLM 不使用）

**コミット:** `137d9d6`

### 実装内容

- **解析は 100% ルールベース**（`@anthropic-ai/sdk` は不採用、`.env.example` からも削除）
- **apps/scraper** に以下のルールモジュールを追加:
  - `classifyPost`: postType / isLotteryInformation / cardType / confidenceScore を判定
    - `lottery_preparation`（会員登録/備えて）を lottery_started から分離
  - `extractLotteryData` / `extractSingleLottery`: 商品名・店舗・応募締切・当選発表等を抽出
  - `classifyUrls`: URL を `application` / `app_download` / `official_information` / `x_post` / `membership_registration` / `image` / `unknown` に分類
  - `keywords.ts`: 分類キーワード辞書
- **packages/shared** に日時ユーティリティ追加:
  - `resolveDate`: 「8/11(火)23:59〆」→ ISO 8601、年省略時は投稿日時から推定（yearInferred）
  - 曜日不一致は `conflicting`、「閉店時間〆」は `store_closing_time`
  - 「後日公開/未定」は `not_published`
- **apps/worker**:
  - `post_analyses` テーブル（migration 0001 / 0002 / 0003）
  - LLM 関連カラム（modelId / promptVersion 等）は設計後に全廃（0003 で DROP）
  - 再解析判定キー: `inputContentHash × parserVersion`（両方一致なら `reused`、どちらかが違えば `inserted`）
  - `lotteries` テーブル（同 migration 0001）— Raw 値（productNameRaw 等）と正規化後を両方保持
  - `normalize.ts`（NORMALIZER_VERSION 管理、NFKC + 装飾記号除去）

### マイグレーション

```sql
-- 0001: lotteries + post_analyses（初期）
-- 0003: post_analyses から LLM 関連カラムを DROP（ルールベース移行）
```

### 再解析ロジック

```
inputContentHash 同一 AND parserVersion 同一 → reused（スキップ）
どちらか違う → inserted（再解析・再登録）
```

---

## Phase 3 — 複数抽選分割 + 同一抽選マッチング/マージ/履歴

**コミット:** `fbf28bd`

### 実装内容

- **apps/scraper** — 複数抽選の分割（`splitLotteries`）:
  - **パターン①**: `✅ / ✔ / ・` マーカー行が2行以上 → 店舗ごとに分割（ヘッダ商品を共有、各行から締切を抽出）
  - **パターン②**: 「」引用商品が2つ以上 + 共通店舗 → 商品ごとに分割
  - 分割成功（全件に商品・店舗あり）→ `analysisStatus: "success"`
  - 分割失敗 → 単一抽出 + `needs_review`
  - `PARSER_VERSION` を `phase3-rules-1` に更新

- **apps/worker** — 同一抽選マッチング:

  **禁止条件（ハードブロック）** — 以下のいずれかに該当したら自動統合しない:
  | 条件 | 説明 |
  |------|------|
  | `card_type_differs` | カード種類が異なる |
  | `store_branch_differs` | 店舗支店が異なる |
  | `deadline_diff_gt_Nd` | 応募締切差が閾値超（デフォルト7日、`MATCH_DEADLINE_BLOCK_DAYS` で調整可） |

  **スコアリング** — ブロックを通過した候補に対してスコアを計算:
  | 項目 | 満点 | 部分一致 |
  |------|------|----------|
  | 商品名 | 40 | 20（部分包含） |
  | 店舗名 | 30 | 15（部分包含） |
  | 支店 + 地域 | 10 | — |
  | 応募締切 | 15（同日）/ 8（1日差） | — |
  | 応募URLドメイン | 5 | — |

  **判定閾値**: `≥80 → merge` / `50–79 → review` / `<50 → new`

- **apps/worker** — 情報マージ（`mergeLotteryData`）:
  - 空欄補完: 既存が空で新規に値あり → 採用
  - 精度ベース日付マージ: `datetime(3) > date_only(2) > inferred(1) > unknown(0)` — 高精度を低精度で上書きしない
  - 競合検出: 両方に異なる値 → `changeType: "conflicting"` + `verificationStatus: "conflicting"`

- **DB 追加** (migration 0004):
  - `lottery_sources`: 1抽選に寄与した投稿・matchAction / matchScore / matchReason / contributedFields
  - `lottery_field_history`: フィールドごとの変更履歴（created / updated / conflicting）

- **冪等性**: 再処理時に `unlinkSourceContributions` で旧 sources / history を削除し、孤立した lottery を自動削除

---

## Phase 4 — URL解決（HTTPリダイレクト追跡）

**コミット:** `2bcfac9`

### 実装内容

- **`resolveUrl` サービス**: t.co 等の短縮URLをHTTPリダイレクト追跡で最終URLに解決
  - `HEAD` → 405 の場合は `GET` にフォールバック
  - タイムアウト 10秒（AbortController）
  - 解決失敗（ネットワークエラー）は `error` を記録して処理継続

- **`processing_jobs` テーブル** (migration 0005):
  - `status`: `pending → running → done / failed`
  - 指数バックオフ: 失敗時は `1分 → 5分 → 15分` で pending に戻す
  - 最大試行回数（デフォルト3）超過で `failed` に固定
  - 楽観的ロック: `lockedAt / lockedBy` でデキュー時の競合防止

- **`processingJobRepository`**:
  - `enqueueJob`: 同一 `jobType × lotteryId（or sourcePostId）` の pending/running が存在する場合はスキップ（重複防止）
  - `dequeueOne`: oldest-pending を取得してロック
  - `markJobComplete` / `markJobFailed`: 完了・失敗の記録

- **`updateLotteryUrls` サービス**: 解決後 URLで lottery を更新。URL 種別が確定（`classifyUrl` で unknown 以外）した場合は `applicationUrl` も差し替え

- **`POST /internal/jobs/process?type=resolve_urls`**: Bearer 認証、最大10件/リクエスト

- **lotteries テーブル追加カラム** (migration 0005):
  - `resolved_application_url` — 解決後 URL
  - `application_url_http_status` — HTTP ステータスコード
  - `url_resolved_at` — 解決日時

- **自動エンキュー**: `syncLotteriesFromAnalysis` で lottery 保存後、`applicationUrl` があれば `resolve_urls` ジョブを自動登録

---

## Phase 5 — 公開API + 内部管理API + 構造化ログ

**コミット:** `ba4c342`

### 実装内容

#### 公開 GET API（認証不要）

| エンドポイント | 説明 |
|----------------|------|
| `GET /lotteries` | 抽選一覧。`cardType` / `verificationStatus` フィルタ、`limit`（最大100）/ `offset` ページネーション |
| `GET /lotteries/:id` | 抽選詳細（`lottery_sources` + `lottery_field_history` 付き） |

#### 内部管理 API（Bearer 認証必須）

| エンドポイント | 説明 |
|----------------|------|
| `GET /internal/review-items` | `needs_review` 一覧（`status` クエリでフィルタ可） |
| `GET /internal/review-items/:id` | 管理詳細（sources + fieldHistory 付き） |
| `POST /internal/review-items/:id/approve` | 承認。`verificationStatus=approved`、`approvedBy` / `approvedAt` を記録 |
| `POST /internal/review-items/:id/reject` | 却下。`verificationStatus=rejected`、`rejectedReason` / `rejectedAt` を記録 |
| `POST /internal/source-posts/:id/reanalyze` | `analyze_post` ジョブをエンキュー（重複防止あり） |

#### lotteries テーブル追加カラム (migration 0006)

- `approved_by` / `approved_at` — 承認者・日時
- `rejected_reason` / `rejected_at` — 却下理由・日時

#### 構造化ログ

Worker の `/ingest` と scraper の `fetchAndProcessTweets` で JSON ログを出力。  
**rawHtml / cleanedHtml / Cookie は一切ログに含まない。**

```json
{
  "batchId": "batch_1234567890",
  "sourcePostId": 1,
  "externalPostId": "1988548187880059026",
  "action": "inserted",
  "postType": "lottery_started",
  "isLotteryInformation": true,
  "analysisStatus": "success",
  "extractedLotteryCount": 1,
  "analysisAction": "inserted",
  "lotteryResults": [
    { "lotteryId": 1, "matchAction": "new", "matchScore": 0, "changedFields": ["normalizedProductName", "normalizedStoreName", "applicationEndDate"] }
  ]
}
```

---

## APIエンドポイント一覧

| 認証 | メソッド | パス | 説明 |
|------|----------|------|------|
| なし | GET | `/` | ヘルスチェック |
| なし | GET | `/lotteries` | 抽選一覧（公開） |
| なし | GET | `/lotteries/:id` | 抽選詳細（公開） |
| Bearer | POST | `/ingest` | 取込API（scraper → worker） |
| Bearer | POST | `/internal/jobs/process` | ジョブ実行（URL解決等） |
| Bearer | GET | `/internal/review-items` | 要確認一覧 |
| Bearer | GET | `/internal/review-items/:id` | 要確認詳細 |
| Bearer | POST | `/internal/review-items/:id/approve` | 承認 |
| Bearer | POST | `/internal/review-items/:id/reject` | 却下 |
| Bearer | POST | `/internal/source-posts/:id/reanalyze` | 再解析ジョブ登録 |

---

## テスト一覧

| パッケージ | ファイル | テスト数 | 主な検証内容 |
|------------|----------|----------|--------------|
| packages/shared | `date.test.ts` | 7 | 年推定・曜日整合・not_published 等 |
| packages/shared | `url.test.ts` | 7 | URL 種別分類・ドメイン抽出 |
| packages/shared | `schemas.test.ts` | 7 | Zod スキーマ検証・contentHash |
| apps/scraper | `lottery.test.ts` | 17 | classifyPost / extractSingleLottery / splitLotteries / analyzePost |
| apps/scraper | `parseTweetDom.test.ts` | 3 | DOM 抽出（React / SSR 両対応） |
| apps/scraper | `imageUrls.test.ts` | 7 | 画像URL抽出・重複排除・cleanedHtml からの除去 |
| apps/worker | `ingest.test.ts` | 6 | 認証・upsert・重複防止 |
| apps/worker | `analysis.test.ts` | 10 | contentHash × parserVersion 再解析判定 |
| apps/worker | `matchExistingLottery.test.ts` | 14 | ハードブロック・スコアリング・判定 |
| apps/worker | `mergeLotteryData.test.ts` | 6 | 空欄補完・精度マージ・競合検出 |
| apps/worker | `processingJob.test.ts` | 9 | enqueue / dequeue / complete / fail / バックオフ |
| apps/worker | `resolveUrl.test.ts` | 5 | HEAD→GET フォールバック・タイムアウト・エラー |
| apps/worker | `lotteries.test.ts` | 8 | 公開GET API・フィルタ・ページネーション |
| apps/worker | `review.test.ts` | 12 | 管理API・承認/却下・reanalyze |
| **合計** | | **118** | |

---

## 設計上の主要決定

| 決定事項 | 理由 |
|----------|------|
| LLM を使わない（100% ルールベース） | コスト・API キー管理・実行環境の制約を排除。ルールで対応できないケースは `needs_review` で人間が確認 |
| 再解析キーを `inputContentHash × parserVersion` の2キーに | contentHash だけでは解析ロジック改善時に既存投稿が再解析されない。parserVersion を追加して解析器バージョンアップ時も再解析可能に |
| 同一抽選マッチングにハードブロック先行 | カード種別・支店・締切差が大きく異なる場合は高スコアでも自動統合しない。誤統合のリスクを排除 |
| `lottery_sources` / `lottery_field_history` を分離 | 複数投稿が1抽選に寄与した場合の出典追跡と変更監査に対応 |
| 冪等性（`unlinkSourceContributions`） | 同じ投稿の再処理時に古いリンクを削除してから再登録。孤立した lottery は自動削除 |
| processing_jobs の指数バックオフ | URL解決の一時的失敗（ネットワーク等）を自動リトライ。上限超過で `failed` に固定し放置を防ぐ |
| 公開APIは認証不要、管理APIは Bearer 必須 | 閲覧は公開してよいが、状態変更（承認/却下/再解析）は認証で保護 |
| rawHtml をログ・Artifact から除外 | 投稿 HTML にセッション情報等が含まれる可能性があるため、ログへの全文出力を禁止 |
