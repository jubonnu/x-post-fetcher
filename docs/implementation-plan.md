# 実装計画方針: X投稿 → 抽選情報 解析・DB登録システム

`docs/test.md` の要件に対する実装方針。現状は `src/index.ts`（取得）+ `src/login.ts`（ログイン）のみの PoC で、DB/ORM/Workers は未導入（greenfield）。

> **⑬ 全体方針（不変）**: 構成 `GitHub Actions → Playwright → Claude → Worker → Turso` は変更しない。段階実装（Phase1〜5）も維持する。本改訂は **設計の精度向上・保守性向上・再解析性向上・安全性向上のみ** を目的とし、既存構成は崩さない。

---

## 0. 前提（test.md との差異・要注意点）

実装前に解消が必要な「違和感」を先に明記する。

| # | 論点 | test.md の記述 | 実際 / 対応方針 |
|---|------|----------------|-----------------|
| 1 | **スクレイパの実行場所を Workers 外に置く（採用判断）** | 「API=Cloudflare Workers」 | **Cloudflare Browser Rendering という選択肢は存在する**。ただし今回のXログイン済みスクレイパでは **セッション維持・安定性・Bot検知・コスト・運用性** を考慮し、`GitHub Actions(Node) → Cloudflare Workers(API) → Turso` へ責務分離する。**「技術的に不可能」ではなく「今回はこの構成を採用する」** という判断。 |
| 2 | **既存DB/ORMが存在しない** | 「既存方式に合わせて」 | 新規選定が必要。**Drizzle ORM + Turso(libSQL)** を採用。 |
| 3 | **画像除外と `imageUrls` 保存の矛盾** | 生データに画像URL必須 | 直前に画像除外実装済み。→ **画像バイナリはDLしない（ブロック維持）が、URLはDOMから抽出して保存**。`rawHtml` は画像URLタグ込みで保存（DB内の生データ源のため）。 |
| 4 | **抽出の中核がフリーテキスト解析** | 純ルール前提に読める | 純ルールだと精度破綻。→ **ハイブリッド**（下記）。 |
| 5 | **スコープ過大** | 全機能＋20テストを一括 | **5フェーズに分割**して段階実装。 |
| 6 | **URL解決のコスト/検知リスク** | 全URLをブラウザ解決 | 基本は**HTTPリダイレクト追跡**で解決。ブラウザ遷移は最小化。 |

---

## 1. 抽出方針（ハイブリッド）

- **ルールベースで実装**: DOM取得（tweetId/投稿者/日時/本文/URL）、明示的な日時表現の正規化、URL分類、曜日整合性チェック、スキーマ検証。
- **Claude API（構造化抽出）で実装**: 投稿分類、複数店舗・複数商品の分割、別セクション（応募期間↔当選発表）の商品名対応付け、店舗名・支店名・地域の意味的抽出。
- **ゲーティング（全投稿をLLMに送らない）**:
  - 明確な対象外投稿はルールで除外
  - 単純な1店舗・1商品はルール抽出を試す
  - 複数商品・複数店舗・複数セクション・曖昧な投稿のみLLMへ
  - LLM出力は **Zod** で検証
  - **日時はLLMを鵜呑みにせず**、投稿日時・曜日・締切前後関係をルールで再検証

### Claude と Worker の責務分離（重要）

**Claude は以下を行わない**（＝意味的な抽出・分割・対応付けの提案までに限定）:
- DB への直接登録・更新
- 既存抽選 ID の最終決定
- 同一抽選かどうかの最終決定
- 既存値の上書き判断
- 日時の最終確定
- 情報源の優先順位決定
- 変更履歴の作成

**Worker が以下を担当する**（＝検証・正規化・確定・永続化）:
- Zod 検証
- 日時の年補完・曜日整合・前後関係の再検証
- 商品・店舗・支店の**正規化**
- 自動統合の禁止条件判定
- 同一抽選スコアリング
- 情報源優先度判定
- 競合管理
- DB 登録・更新
- 変更履歴保存

---

## 2. 実行構成

```
GitHub Actions (cron 5min, Node)                Cloudflare Workers            Turso(libSQL)
┌───────────────────────────────┐   POST /ingest  ┌────────────────────┐   Drizzle  ┌─────────┐
│ Playwright fetch (既存流用)      │  (Bearerトークン) │ 検証(Zod)          │ ─────────▶ │ tables  │
│ → DOM生データ抽出(ルール)        │ ───────────────▶ │ upsert/重複判定     │            │         │
│ → 分類/抽出 ゲーティング          │                  │ 同一抽選マッチング   │ ◀───────── │ (read)  │
│   simple:ルール / complex:Claude │                  │ 統合+履歴           │            └─────────┘
│ → Zodで自己検証 → payload        │                  │ 構造化ログ           │
└───────────────────────────────┘                  │ 公開API(GET)        │
                                                    └────────────────────┘
```

- **LLM構造化はスクレイパ側(GA Node)** で実行し、構造化済み payload を Worker へ POST。
- **同一判定・統合・履歴は Worker 側**（Turso の既存抽選を読む必要があるため）。
- GitHub Actions: **cron 最短5分・workflow_dispatch（手動）・concurrency で多重起動防止**。
- `auth.json` は **Base64化して GitHub Secrets に保存 → 実行時に一時ファイル復元**（コミット禁止）。
- **GA→Turso 直結せず、必ず Worker の内部取込API経由**。
- **取込API認証**: PoC は **Bearer 認証**。将来的に **HMAC 署名** へ移行可能とする（改ざん・リプレイ耐性）。
  - ヘッダ例: `Authorization`（Bearer or 署名スキーム）/ `X-Batch-Id` / `X-Timestamp` / `X-Signature`（HMAC-SHA256）
  - `X-Timestamp` で時刻ずれ検証、`X-Signature` で本文＋タイムスタンプの署名検証を行う想定。

### 取込（/ingest）処理フローと失敗時の扱い

Worker 側 `/ingest` の処理順:
1. 認証（Bearer / 将来 HMAC）
2. `sourcePost` の Zod 検証 → upsert（`externalPostId` UNIQUE / `contentHash`）
3. `analysis` payload の Zod 検証 → `post_analyses` 保存（再解析条件は §5 参照）
4. 抽選候補の抽出結果を受領
5. **抽選候補の同一判定**（禁止条件 → スコアリング）
6. **新規登録または既存抽選への統合**
7. **変更履歴を保存**（`lottery_field_history`）
8. **処理結果を構造化ログへ出力**

**失敗時の扱い（投稿単位で隔離、バッチ全体は止めない）**:
- `sourcePost` 保存失敗 … その投稿の**取込全体を失敗扱い**（後続をスキップ）
- `analysis` 検証失敗 … `sourcePost` は**保持**し、`post_analyses.status = needs_review`
- 同一判定または統合失敗 … **元投稿と解析結果を保持**し、再処理可能にする（`processing_jobs` へ）
- 解析結果がない場合でも … **生投稿だけを登録可能**にする（`source_posts` は必ず残す）

---

## 3. 技術選定（新規・推奨）

| 項目 | 採用 | 理由 |
|------|------|------|
| ORM | **Drizzle** | libSQL/Turso アダプタ・Workers対応・マイグレーション |
| Worker ルータ | **Hono** | 軽量・Workers標準的 |
| 検証 | **Zod** | shared に置き scraper/worker で共用 |
| LLM SDK | **@anthropic-ai/sdk** | モデルは精度重視で Sonnet 4.6／コスト優先で Haiku 4.5。実装時に `claude-api` スキルでモデルID・料金を確認 |
| モノレポ | **npm workspaces** | 2ランタイム＋共有パッケージを分離 |

---

## 4. リポジトリ構成（workspaces モノレポへ再編）

```
packages/shared/          # Node/Workers 両方で使う純粋ロジック
  src/types.ts            # 共通型（PostType, CardType, Precision, Status 等）
  src/schemas.ts          # Zod: 取込payload / LLM出力スキーマ
  src/utils/{date,url,hash}.ts   # 日時正規化・年推定・曜日整合 / URL分類 / contentHash
apps/scraper/             # GitHub Actions(Node)
  src/scraping/x/{fetchTweets,parseTweetDom,selectors}.ts  # 既存 index.ts を分解
  src/lottery/{classifyPost,extractLotteryData,resolveDates,calculateConfidence}.ts  # 抽出・分類・提案まで
  src/llm/claudeClient.ts # Claude構造化（ゲーティング後のみ呼ぶ）
  src/jobs/fetchAndProcessTweets.ts  # オーケストレーション→Worker取込APIへPOST
  src/login.ts            # 既存流用
apps/worker/              # Cloudflare Workers + Turso
  src/index.ts            # Honoルータ: 内部/ingest（トークン認証）, 公開GET, /internal 管理
  src/db/{schema.ts,client.ts} + migrations/
  src/repositories/{sourcePost,lottery,lotterySource,lotteryHistory,processingJob}Repository.ts
  src/services/{normalizeProduct,normalizeStore,resolveDates,matchExistingLottery,mergeLotteryData}.ts  # 正規化・確定・統合はWorker
  wrangler.toml
.github/workflows/scrape.yml
```

> test.md のモジュール分割意図を尊重しつつ、**確定・正規化・DB系（`normalize*`/`resolveDates`(再検証)/`matchExistingLottery`/`mergeLotteryData`）は Worker側**、**抽出・分類・LLM提案（`classifyPost`/`extractLotteryData`/`claudeClient`）は scraper側**に配置（§1 の責務分離に準拠）。

### 既存コードの再利用

`src/index.ts` の以下を `apps/scraper/src/scraping/x/` へ移して流用:
- `expandAllPosts`（「さらに表示 / Show more / 原文」を `page.evaluate` 内 `.click()` で展開・翻訳解除）
- `extractVisiblePosts`（React `data-testid="tweet"` と SSR `data-tweet-id` 両対応、`time[datetime]`・`a[href*="/status/"]`・`[data-testid="tweetText"]`）
- `collectPosts`（スクロール収集・日時降順）
- `context.route` 画像/動画DLブロック、`cleanHtml`

`src/login.ts`（実物Chrome + storageState）→ 流用し GA Secret 復元に対応。

---

## 5. DBテーブル（Drizzle schema, Phaseで順次追加）

`source_posts` / `post_analyses` / `lotteries` / `lottery_sources` / `lottery_field_history` / `processing_jobs`
（各カラムは test.md 準拠。`externalPostId` に UNIQUE、日時は value / precision / status / raw*Text を分離保持）

### 追加・明確化するカラム／テーブル

- **`post_analyses`（再解析性）**: 以下のカラムを保存する。
  - `parserVersion` / `promptVersion` / `modelId` / `inputContentHash` / `analyzedAt`
  - **再解析する条件**（いずれか）:
    - `source_posts.contentHash` が前回の `inputContentHash` と異なる
    - `parserVersion` が異なる
    - `promptVersion` が異なる
    - `modelId` が異なる
    - 前回の解析ステータスが `failed` または `needs_review` で、再試行条件（最大試行未満・`nextRetryAt` 経過）を満たす
  - **再利用（Claude 再実行しない）条件**: 同じ `inputContentHash` × `parserVersion` × `promptVersion` × `modelId` の組み合わせで**解析成功済み**なら、Claude API を再実行せず既存解析結果を再利用する。
  - post_analysis だけが失敗しても、対象を `needs_review` にして **再解析可能**にする（source_posts は保持済みなので、バージョン更新時に再解析できる）。
- **`lotteries`（⑤正規化前情報の保持）**: 以下を追加し、**正規化前の Raw 値を必ず保持**する。
  - `productNameRaw` / `normalizedProductName`
  - `storeNameRaw` / `normalizedStoreName`
  - `storeBranchRaw` / `normalizedStoreBranch`
  - `normalizerVersion`（正規化ロジックのバージョン。ロジック改善時の再正規化に使う）
- **`processing_jobs`（ジョブ管理／非同期・リトライ・排他制御）**: 後続処理をジョブ化して用途を明確化する。
  - `jobType`: `analyze_post` / `resolve_urls` / `match_lottery` / `merge_lottery`
  - `status`（例: pending / running / done / failed / needs_review）
  - `attempts`（試行回数）/ `nextRetryAt`（次回リトライ時刻）/ `lastError`（最終エラー）
  - **排他制御用**: `lockedAt` / `lockedBy` / `completedAt` / `createdAt` / `updatedAt`
  - 加えて `id` / `sourcePostId`（or `lotteryId`）。
  - **重複ジョブ防止**: `jobType` × `sourcePostId` × `parserVersion` × `promptVersion` × `modelId` の組み合わせで、同一処理が二重登録されないようにする（UNIQUE 制約 or 事前チェック）。
  - **ジョブ取得（ワーカー実行）時のルール**:
    - `pending` のみ取得する
    - **ロック取得に成功した処理だけ実行**（`lockedAt`/`lockedBy` をアトミックにセット）
    - 古い `lockedAt` はタイムアウト後に再取得可能（スタックしたジョブの回収）
    - 成功時は `done` と `completedAt` を記録
    - 失敗時は `attempts` を増加
    - 最大試行回数超過時は `failed` または `needs_review`

### rawHtml / cleanedHtml / R2 方針

- **`rawHtml`**: 取得した対象 `article` 要素の**加工前HTML**。
- **`cleanedHtml`**: 解析に不要なUI・ボタン・装飾・SVG などを除去したHTML。
- **原則としてページ全体のHTMLではなく、対象投稿の `article` 要素だけを保存**する。
- **PoC での許容**: `rawHtml` と `cleanedHtml` は当面 **Turso に保存**してよい。将来的に肥大化する場合は **Cloudflare R2 へ退避**（DBにはキー参照のみ）する方針とする。

---

## 6. 段階実装（フェーズ）

### Phase 1 — 保存層 + 生データ抽出（基盤）
- workspaces化、`packages/shared`（types/Zod/`utils:{date,url,hash}`）。
- Worker: Drizzle+Turso、`source_posts`（+マイグレーション, `externalPostId` UNIQUE）、`/ingest`（Bearer認証）で **externalPostId upsert + contentHash** 重複回避。
- Scraper: 既存取得を `scraping/x/*` に分解し **生データ**（tweetId, 投稿者id/username/表示名=`[data-testid="User-Name"]`, publishedAt, url, body, 本文内リンク, アンカーの展開後URL, imageUrls, fetchedAt, rawHtml, contentHash）を生成→ `jobs/fetchAndProcessTweets.ts` から Worker へPOST。
- `.github/workflows/scrape.yml`（cron5分, workflow_dispatch, concurrency, auth.json をBase64 Secretから一時復元, Playwright install）。
- テスト: DOM抽出(#19 さらに表示前後 / #20 data-testid堅牢性)、contentHash重複(#14)。

### Phase 2 — 分類 + 単一抽選抽出
- ルール分類器（postType/isLotteryInformation/cardType）。「抽選」語のみで判定せず `lottery_preparation` を判別（会員登録/購入履歴/～に備えて 等）。
- ルールで 1店舗1商品抽出 + `resolveDates`（precision/status、年省略→投稿日+月+曜日で推定、曜日不一致は `conflicting`/`yearInferred`）。
- `claudeClient` + ゲーティング（複雑/曖昧のみLLM）、**Zod検証**。
- **簡易URL処理（ルールのみ・ここへ移動）**: DOM内アンカーから取得済みの**展開後 `href` を保存**し、`domain` を抽出。以下の**明確なURL種別だけルール分類**する。
  - `x_post` / `image` / `app_download` / `membership_registration` / `application` / `official_information` / `unknown`
  - App Store・Google Play → `app_download` ／ X投稿URL → `x_post` ／ 画像URL → `image` ／ 会員登録ページ → `membership_registration`
  - ※ **リダイレクト追跡による最終URL解決（`resolvedUrl`/`finalUrl`/`httpStatus`）は Phase 4** で行う。Phase 2 は「DOMから取れる展開後hrefの保存＋ドメインと明確な種別のルール分類」までに留める。
- Worker: `post_analyses`（+マイグレーション）保存。**`parserVersion`/`promptVersion`/`modelId`/`inputContentHash` を記録**し、解析失敗時は `needs_review` にして再解析可能にする。`lotteries` 挿入（マッチングは簡易）。
- テスト: #4,#9,#10,#11,#12,#13,#17,#18。

### Phase 3 — 複数分割 + 同一判定 + 統合 + 履歴
- Claudeで複数店舗/商品の分割・別セクション（応募期間↔当選発表）の**商品名キー対応付け**。
- **⑪ Worker の責務を明記**: 取込された投稿の **重複判定・同一抽選マッチング・情報統合・変更履歴保存** はすべて Worker 側が担当する（Turso の既存抽選を読む必要があるため）。URL解決は Phase 4 で `processing_jobs`（`resolve_urls`）として非同期実行。
- Worker `services/matchExistingLottery`:
  - **④ スコア判定前の「禁止条件（ハードブロック）」を先に評価する。** 以下のいずれかに該当する場合は、**スコアが高くても自動統合しない**（新規 or 要確認とする）:
    - カード種類が異なる
    - 店舗支店が異なる
    - オンラインと店頭が異なる
    - 販売形態が異なる（抽選 / 予約 / 通常販売 / 再販 等）
    - 応募締切が大きく異なる（**閾値はデフォルト 7 日**。ただし固定ではなく環境変数等で**調整可能な設定値**とする）
    - 再抽選・第2回など別抽選回
  - **締切差ルールの補足**: 片方の締切が未確定（`not_published`/`store_closing_time` 等）の場合は締切差でブロックせず、他の禁止条件とスコアで判断する。閾値以上の差は「別抽選回の可能性」として `needs_review` に落とすことも可。
  - 禁止条件を通過したものだけスコアリング（商品40/店舗30/支店地域10/締切15/ドメイン5、80+自動統合/50–79要確認/49–以下新規）。**スコアと判定理由（禁止条件でのブロック理由含む）を保存**。
- `mergeLotteryData`（情報源優先度、空欄補完、競合→`verificationStatus=conflicting` で両方保持・要確認キュー、低信頼で高信頼を上書き禁止）+ `lottery_sources` + `lottery_field_history`。
- テスト: #1,#2,#3,#5,#6,#7,#8,#15,#16。

### Phase 4 — URL解決（最終URLの実解決）
- **Phase 2 との責務差**: Phase 2 は「DOMから取れる展開後 `href` の保存＋`domain`＋明確な種別のルール分類」。**Phase 4 は実際にネットワークで最終URLを解決**する。
- t.co →`resolvedUrl/finalUrl/httpStatus` を **HTTPリダイレクト追跡**で解決（ブラウザ遷移は最小化）。`processing_jobs` の `resolve_urls` として非同期実行。
- 解決後に種別を確定（AppStore/GooglePlay→`app_download`、会員登録→`membership_registration` 等）。到達不可/認証要は null 許容。

### Phase 5 — 公開API + 管理導線 + 仕上げ + 統合テスト
- Worker 公開GET API（抽選一覧等）。
- **`needs_review` の管理導線（内部管理API または CLI）** を追加:
  ```text
  GET  /internal/review-items
  GET  /internal/review-items/:id
  POST /internal/review-items/:id/approve
  POST /internal/review-items/:id/reject
  POST /internal/source-posts/:id/reanalyze
  ```
  - **内部APIは公開APIと認証を分離**（Bearer トークン or Cloudflare Access 等で保護）
  - `approve` 時: **承認者・承認日時・採用した値**を記録
  - `reject` 時: **理由**を記録
  - `reanalyze` 時: 対象の `source_posts` に対し再解析ジョブ（`processing_jobs` の `analyze_post`）を enqueue
- 構造化ログ（batchId/tweetId/sourcePostId/postType/extractedLotteryCount/matchedLotteryId/matchScore/action/changedFields/error、**rawHtml全文はログに出さない**）。
- 投稿単位のエラー隔離（DOM/日時/URL/商品店舗不明/DB失敗でバッチ停止しない、解析不能でも `source_posts` 保存）。
- test.md「実装後の出力」10項目の報告。

---

## 7. 検証方法

- **⑨ fixture ベースの再現可能テスト（主）**: 実X に依存せず、**取得済み HTML を fixtures として保存**し、それを入力に DOM抽出〜分類〜抽出〜マッチングを検証する。
  - 例: `apps/scraper/tests/fixtures/`（または `packages/shared/tests/fixtures/`）配下に
    `single-product.html` / `multi-product.html` / `multi-store.html` / `preparation-post.html` / `closing-time.html` / `unknown-product.html` など。
  - 各 test.md ケース（#1〜#20）に対応する fixture を用意し、実Xの変動に左右されない安定テストにする。
- **実X テストは smoke test 扱い**: 実際のプロフィールに対する取得は「疎通確認（少数・低頻度）」に留め、CI の主軸にはしない。
- **Phase毎 end-to-end**: `wrangler dev` で Worker ローカル起動 → scraper をローカル実行 → `/ingest` へPOST → Turso 行を確認。
- **単体テスト（Vitest）**: 日時正規化・年推定・曜日整合・URL分類・分類器・スコアリング（禁止条件含む）・マージを純関数でテスト。
- **DOM堅牢性**: `data-testid` で取得できること、「さらに表示」展開前後の本文差分（#19,#20）。
- **重複/差分**: 同一投稿2回で upsert され増えない・contentHash変化で再解析（#14）。
- 既存 `npm run login` / `npm run fetch` の回帰確認。

---

## 8. LLM（Claude）失敗時の処理

- 解析ステータスを `failed` または `needs_review` にする。
- `errorCode` と `errorMessage` を保存する。
- `processing_jobs` に**再試行情報**（`attempts`/`nextRetryAt`）を保存する。
- **既存の `lotteries` は更新しない**（失敗で確定値を壊さない）。
- **レート制限や一時障害は指数バックオフ**でリトライ。
- **JSON不正や Zod 不一致は、同一モデルへの無限再試行をしない**（スキーマ違反は待っても直らないため）。
- 最大試行回数を超えた場合は**手動確認対象（needs_review）**にする。

---

## 9. 認証情報（auth.json）の保護

- `auth.json` は**コミット禁止**（Base64 で GitHub Secrets 保存 → 実行時に一時ファイル復元）。
- 保存する `rawHtml`/`cleanedHtml` に **Cookie や storage state（セッション）が混入しないよう確認**する（`article` 要素のみ保存し、ページ全体やスクリプト・localStorage を含めない）。
- **失敗時の Artifact 収集対象から認証ファイル（`auth.json` 等）を明示的に除外**する（CIログ・アーティファクトに漏らさない）。

---

## 10. 残る制約とリスク（正直な明示）

- **アカウント凍結リスク大**: GitHub Actions のデータセンタ IP から**ログイン状態で5分間隔**のスクレイピングは Xのbot検知・凍結リスクが高い。捨て垢必須。頻度緩和や residential proxy 検討の余地。ToS抵触は継続。
- **auth.json のセッション寿命**: 期限切れ/再認証で失敗しうる→失敗検知と再ログイン運用（Secret更新）が必要。
- **LLM抽出の不確実性**: ゲーティング+Zod+日時ルール再検証で低減するが誤りは残る→`needs_review` と履歴で回収。
- **URL解決**: 一部は最終URL到達不可/認証要で null 許容。
- **コスト**: Claude API（複雑投稿のみ）と GA 実行時間。5分間隔だと積み上がる→ゲーティングと contentHash 未変化スキップで抑制。
