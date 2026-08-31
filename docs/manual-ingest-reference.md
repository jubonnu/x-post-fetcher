# X手動検証・DB投入リファレンス

Claude in ChromeでXの投稿を手動確認しながら抽選データを既存DBへ投入する際の参照用。
現在の自動収集パイプライン(`apps/scraper`)の挙動と、`POST /ingest`のデータ投入フォーマットをまとめる。

## A. 現在のX取得条件

### A1. 対象アカウント
- 単一アカウントのみ(複数アカウント設定の仕組みは無い): `TARGET_USER`環境変数、デフォルト`Zabi_pokeka`
  (`apps/scraper/src/jobs/fetchAndProcessTweets.ts:255`)
- Playwrightでプロフィールページ(`https://x.com/{targetUser}`)をスクレイピング。X公式APIは未使用
- 対象アカウント本人の投稿のみ採用(リツイート/他アカウントの投稿・ピン留めは除外)

### A2. 実行トリガー
- GitHub Actions cron: 毎時0分(`.github/workflows/scrape.yml`、`cron: "0 * * * *"`)
- 手動実行も可能(`workflow_dispatch`)
- 二重実行防止(`concurrency`)、1回のジョブは10分でタイムアウト

### A3. 「抽選投稿」の判定ロジック
2段階のフィルタがある:

1. **`classifyPost.ts`**: `postType`を判定(キーワードマッチ)。`lottery_started`/`lottery_summary`等13種類に分類
2. **`entryPurpose.ts`**(実際の抽出ゲート): 正規化テキストに対して
   - 「抽選結果発表」を含む → `result`
   - 「抽選まとめ」等 → `summary`
   - 「抽選開始」「抽選告知」「抽選受付」等 → `new_lottery`
   - 「抽選」+「スタート」両方 → `new_lottery`
   - 「抽選」+ 締切マーク「〆」が2つ以上 → `summary`
   - 上記以外 → `ignored`(抽出は一切行われない。投稿自体はDBに保存される)

主要キーワード例: `抽選開始`,`応募受付中`,`応募期間`,`締切`,`当選発表`,`応募はこちら`,`抽選販売`,`抽選受付`
(全キーワードは`apps/scraper/src/lottery/keywords.ts`参照)

### A4. 抽出対象フィールド(1抽選あたり)

| フィールド | 内容 |
|---|---|
| `cardType` | `pokemon`\|`onepiece`\|`other`\|`unknown` |
| `productNameRaw` | 商品名(「」『』内の引用テキストから) |
| `storeNameRaw` | 店舗名(「〜で/では/にて」パターンから) |
| `storeBranchRaw` | 支店名(まとめ投稿の場合のみ) |
| `region` | 未実装、常にnull |
| `applicationStart` / `applicationEnd` | 応募開始/締切(`ResolvedDate`型) |
| `resultAnnouncementStart` / `resultAnnouncement` | 当選発表開始/期限 |
| `purchaseStart` / `purchaseDeadline` | 購入開始/期限 |
| `confirmedOpenAt` | 「抽選開始されました」等の即時性表現があれば投稿時刻を採用 |
| `applicationUrl` | 応募URL(店舗公式ドメイン表・近接キーワード等で5段階の優先度判定) |
| `officialInformationUrl` / `appDownloadUrl` | 公式情報/アプリDLのURL |
| `applicationMethod` | 応募方法の説明行 |
| `eligibilityConditions` | 未実装、常にnull |
| `pickupMethod` / `paymentMethod` | 受取/支払方法の説明行 |
| `price` | 価格を含む行 |
| `notes` | 未実装、常にnull |

`ResolvedDate`の型:
```ts
{
  at: string | null;       // ISO8601 datetime (timezone offset付き)
  date: string | null;     // "YYYY-MM-DD"
  precision: "datetime" | "date_only" | "store_closing_time" | "inferred" | "unknown";
  status: "unknown" | "not_published" | "extracted" | "verified" | "conflicting";
  rawText: string | null;
  yearInferred: boolean;
}
```

これらは全て正規表現・キーワードマッチのみで抽出しており、LLM/画像は一切使用していない
(画像バイナリはネットワークレベルでブロックし、1x1ダミー画像に差し替えている)。

## B. 既存DBへの投入フォーマット(`POST /ingest`)

### B1. エンドポイント・認証
- `POST {WORKER_ORIGIN}/ingest`(production: `https://x-post-ingest.bakushi-log.workers.dev/ingest`、staging: `https://x-post-ingest-staging.bakushi-log.workers.dev/ingest`)
- ヘッダー: `Authorization: Bearer <INGEST_TOKEN>`(トークン未設定なら常に401)
- `Content-Type: application/json`

### B2. リクエストボディ全体構造

```jsonc
{
  "batchId": "optional-string",
  "sourcePost": { /* 必須。B3参照 */ },
  "analysis": { /* 省略可。付けない場合は投稿保存のみでlottery抽出は行われない。B4参照 */ }
}
```

### B3. `sourcePost`(必須オブジェクト)

| フィールド | 型 | 必須 | 備考 |
|---|---|---|---|
| `platform` | `"x"` | 省略可(default `"x"`) | |
| `externalPostId` | string | **必須** | Xの投稿ID(ツイートID) |
| `authorId` / `authorUsername` / `authorDisplayName` | string\|null | 省略可 | |
| `bodyRaw` | string | 省略可(default `""`) | 投稿本文 |
| `publishedAt` | ISO8601(timezone offset必須)\|null | 省略可 | 例: `"2026-08-31T10:00:00+09:00"` |
| `sourceUrl` | string(URL形式必須) | **必須** | 投稿へのURL |
| `imageUrls` | string[] | 省略可(default `[]`) | 添付画像のURL一覧 |
| `externalUrls` | string[] | 省略可(default `[]`) | 本文中の外部リンク |
| `rawHtml` / `cleanedHtml` | string | 省略可(default `""`) | |
| `contentHash` | string | **必須** | 再送時の変更検知用(同一なら"unchanged"扱い) |
| `fetchedAt` | ISO8601(timezone offset必須) | **必須** | 取得日時 |

### B4. `analysis`(省略可オブジェクト。付けるとlottery抽出・保存まで走る)

| フィールド | 型 | 必須 |
|---|---|---|
| `postType` | 13種類のenum(下記) | **必須** |
| `isLotteryInformation` | boolean | **必須** |
| `cardType` | `"pokemon"\|"onepiece"\|"other"\|"unknown"` | **必須** |
| `confidenceScore` | number(0〜1) | **必須** |
| `analysisStatus` | `"success"\|"needs_review"\|"failed"`(default `"success"`) | 省略可 |
| `parserVersion` | string | **必須**(手動投入なら任意の識別文字列でよい、例: `"manual-claude-in-chrome-v1"`) |
| `inputContentHash` | string | **必須**(再解析の重複防止キー。`sourcePost.contentHash`と同じ値でよい) |
| `extractedLotteries` | `ExtractedLottery[]`(省略可、default `[]`) | 省略可 |
| `urls` | `ClassifiedUrl[]`(省略可) | 省略可 |
| `errorMessage` | string\|null | 省略可 |

`postType`のenum値: `lottery_started`,`lottery_summary`,`lottery_scheduled`,`lottery_updated`,`deadline_extended`,`result_announced`,`purchase_information`,`lottery_cancelled`,`lottery_preparation`,`reservation`,`general_sale`,`restock`,`unrelated`

`extractedLotteries`内の各要素はA4の`ExtractedLottery`型と同一(全フィールド省略可、省略時は`null`または空の`ResolvedDate`扱い)。

### B5. 投入後の挙動(参考)

- `sourcePost`は`externalPostId`をキーに upsert(新規/内容一致で"unchanged"/内容変更で"updated")
- `analysis`を付けた場合、`(inputContentHash, parserVersion)`の組み合わせが既存と同一なら再解析はスキップされる(重複投入防止)。**手動で何度も投入し直したい場合は`inputContentHash`か`parserVersion`を変えること**
- 抽出されたlotteryは既存レコードとの同一性マッチング(`matchExistingLottery`)を経て、新規/更新/`lottery_update_candidates`(要確認)のいずれかに振り分けられる。DBへ直接書き込む経路は無い

### B6. 最小構成の投入例

```json
{
  "sourcePost": {
    "externalPostId": "1234567890",
    "sourceUrl": "https://x.com/Zabi_pokeka/status/1234567890",
    "bodyRaw": "「ポケモンカード151」抽選開始しました。〇〇店で応募受付中...",
    "contentHash": "manual-20260901-01",
    "fetchedAt": "2026-09-01T09:00:00+09:00"
  },
  "analysis": {
    "postType": "lottery_started",
    "isLotteryInformation": true,
    "cardType": "pokemon",
    "confidenceScore": 0.9,
    "parserVersion": "manual-claude-in-chrome-v1",
    "inputContentHash": "manual-20260901-01",
    "extractedLotteries": [
      {
        "cardType": "pokemon",
        "productNameRaw": "ポケモンカード151",
        "storeNameRaw": "〇〇店",
        "applicationEnd": { "at": "2026-09-05T21:00:00+09:00", "date": null, "precision": "datetime", "status": "extracted", "rawText": "9/5 21:00〆", "yearInferred": false },
        "applicationUrl": "https://example.com/apply"
      }
    ]
  }
}
```
(未指定フィールドはスキーマのdefaultが適用される。日付が分からない項目は`ResolvedDate`ごと省略してよい)

## C. 管理画面「Claude投入」を使う場合(推奨)

`POST /ingest`を直接叩く(B節)代わりに、管理画面の「Claude投入」ページ(`/claude-ingest`)から貼り付けるのが推奨の運用方法。
`INGEST_TOKEN`を扱う必要が無く(管理画面のログインのみで完結)、貼り付け前にプレビュー・検証ができる。
保存処理の中身(sourcePost upsert・analysis保存・lottery matching・重複判定)は`POST /ingest`と完全に同じ共通処理
(`apps/worker/src/services/ingestPost.ts`)を使っているため、投入結果はB節の`/ingest`と変わらない。

### C1. 投稿JSONの形式(flattened形式)

Claude in Chrome等で生成するJSONは、B節の`{sourcePost, analysis}`ネスト形式ではなく、投稿ごとに1オブジェクトの配列(flattened形式)で渡す。管理画面が内部でネスト形式へ変換し、`contentHash`/`inputContentHash`もサーバー側で自動算出する(手動で用意する必要は無い)。

```jsonc
[
  {
    "externalPostId": "1234567890",
    "sourceUrl": "https://x.com/Zabi_pokeka/status/1234567890",
    "publishedAt": "2026-09-01T09:00:00+09:00",
    "bodyRaw": "「ポケモンカード151」抽選開始しました。〇〇店で応募受付中...",
    "postType": "lottery_started",
    "isLotteryInformation": true,
    "cardType": "pokemon",
    "confidenceScore": 0.9,
    "extractedLotteries": [
      {
        "productNameRaw": "ポケモンカード151",
        "storeNameRaw": "〇〇店",
        "applicationEnd": "2026-09-05T21:00:00+09:00",
        "applicationUrl": "https://example.com/apply"
      }
    ]
  }
]
```

**日付フィールド(`applicationStart`/`applicationEnd`/`resultAnnouncementStart`/`resultAnnouncement`/`purchaseStart`/`purchaseDeadline`)は2つの形式を受け付ける:**

1. **フルの`ResolvedDate`オブジェクト(優先・推奨)** — 上記例の代わりに以下のように書くと、`rawText`等の情報が一切失われずそのままDBへ保存される:
   ```json
   "applicationEnd": {
     "at": "2026-09-05T21:00:00+09:00",
     "date": "2026-09-05",
     "precision": "datetime",
     "status": "extracted",
     "rawText": "9/5(金)21:00頃〆予定",
     "yearInferred": false
   }
   ```
   投稿本文の「頃」「以降」「予定」「本日」等のニュアンスは`rawText`に残すこと。可能な限りこちらの形式で出力するのが望ましい。
2. **フラットなISO文字列/日付のみ文字列(フォールバック)** — `"2026-09-05T21:00:00+09:00"`(ISO datetime)または`"2026-09-05"`(`YYYY-MM-DD`)。この場合サーバー側で`ResolvedDate`オブジェクトへ変換するが、`rawText`等のニュアンス情報は失われる(`precision`は`"datetime"`または`"date_only"`、`status`は`"extracted"`になる)。

**上記どちらの形式にも一致しない文字列(例: 「9月頃」のような未加工の自由記述)は検証エラーとして弾かれ、DBには保存されない**(silentに"unknown"へ丸めることはしない)。管理画面のValidateボタンでこのエラーを確認できる。

### C2. エンドポイント

- `POST /admin/claude-ingest`(要管理者ログイン) — body: `{"posts": [投稿オブジェクトの配列]}`。レスポンスは`{"results": [...]}`で投稿ごとの結果(`inserted`/`updated`/`unchanged`や検証エラー)を返す。1件が失敗しても他の件は処理を継続する。
- `GET /admin/claude-ingest/checkpoint?authorUsername=Zabi_pokeka` — 「Xで最後に確認した投稿」のチェックポイントを取得。
- `PUT /admin/claude-ingest/checkpoint` — body: `{"authorUsername", "externalPostId", "publishedAt"}`でチェックポイントを更新(`checkedAt`はサーバー側で自動設定)。**「最後にDBへ保存した投稿」とは別概念**で、抽選対象外でDBに保存しなかった投稿でもチェックポイントには設定できる。将来Claude in Chromeを定期実行する際の取りこぼし防止用の土台で、現時点では自動更新されない(管理画面から手動で更新する)。

## 参照元(コード上の根拠)

- スクレイパー対象/実行トリガー: `apps/scraper/src/jobs/fetchAndProcessTweets.ts`, `.github/workflows/scrape.yml`
- 分類ロジック: `apps/scraper/src/lottery/classifyPost.ts`, `entryPurpose.ts`, `keywords.ts`
- 抽出ロジック: `apps/scraper/src/lottery/extractLotteryData.ts`, `analyzePost.ts`
- 型定義: `packages/shared/src/schemas.ts`
- ingestエンドポイント: `apps/worker/src/routes/ingest.ts`, `apps/worker/src/services/ingestPost.ts`, `apps/worker/src/repositories/sourcePostRepository.ts`, `apps/worker/src/repositories/analysisRepository.ts`
- 管理画面Claude投入: `apps/worker/src/routes/adminClaudeIngest.ts`, `apps/worker/src/services/claudeIngestTransform.ts`, `apps/admin-web/src/pages/ClaudeIngestPage.tsx`
- チェックポイント: `apps/worker/src/repositories/scrapeAuthorStateRepository.ts`(`scrapeAuthorStates`テーブルの`claudeChecked*`カラム)
- DBスキーマ: `apps/worker/src/db/schema.ts`(`sourcePosts`, `lotteries`, `scrapeAuthorStates`テーブル)
