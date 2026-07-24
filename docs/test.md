既存の Playwright による X 投稿取得プロジェクトを修正してください。

## 目的

X から取得したトレーディングカード関連の投稿を解析し、抽選販売に必要な情報だけを抽出して DB へ登録してください。

X の 1 投稿をそのまま抽選情報として保存するのではなく、以下の考え方で実装してください。

-   1 投稿に複数の抽選情報が含まれる場合がある
-   同じ抽選について、締切・当選発表・購入期限などが別投稿で後日公開される場合がある
-   投稿は情報源として保存する
-   抽選情報は「商品 × 店舗 × 店舗支店・地域 × 抽選回」を単位として管理する
-   後続投稿から取得した情報を既存の抽選レコードへ統合する
-   変更前の値と情報元を履歴として残す
-   情報が不足していても、取得済み部分だけで登録可能にする

## 全体処理

以下の処理フローを実装してください。

1. Playwright で X 投稿を取得
2. 投稿の生データを保存
3. 投稿本文、投稿日時、投稿 URL、投稿者、本文内リンク、画像 URL を抽出
4. 投稿が抽選情報か判定
5. 投稿種別を分類
6. 商品名、店舗名、応募期間などを抽出
7. 1 投稿に複数の抽選があれば個別レコードに分割
8. 既存抽選との同一性を判定
9. 新規登録または既存抽選を更新
10. 値が変更された場合は変更履歴を保存
11. 処理結果とエラーをログに残す

## ディレクトリ構成

既存構成を確認したうえで、責務を分離してください。

例：

src/
scraping/
x/
fetchTweets.ts
parseTweetDom.ts
selectors.ts

lottery/
classifyPost.ts
extractLotteryData.ts
normalizeProduct.ts
normalizeStore.ts
resolveDates.ts
matchExistingLottery.ts
mergeLotteryData.ts
calculateConfidence.ts
types.ts

repositories/
sourcePostRepository.ts
lotteryRepository.ts
lotterySourceRepository.ts
lotteryHistoryRepository.ts

jobs/
fetchAndProcessTweets.ts

utils/
url.ts
date.ts
hash.ts
logger.ts

Playwright のファイルにはブラウザ操作と DOM 取得を中心に記述し、本文解析や DB 登録を直接大量に書かないでください。

## X 投稿から取得する生データ

以下を取得してください。

-   tweetId
-   投稿者 ID
-   投稿者ユーザー名
-   投稿者表示名
-   投稿日時
-   投稿 URL
-   投稿本文
-   本文内リンク
-   展開後 URL
-   画像 URL
-   取得日時
-   rawHtml
-   contentHash

X 本体の DOM では、可能な限り以下を利用してください。

-   article[data-testid="tweet"]
-   [data-testid="tweetText"]
-   time[datetime]
-   a[href*="/status/"]
-   [data-testid="User-Name"]

ランダムに変化する CSS クラス名には依存しないでください。

「さらに表示」が存在する場合はクリックしてから本文を取得してください。

## 投稿分類

投稿を以下の種別に分類してください。

-   lottery_started

    -   抽選開始

-   lottery_summary

    -   複数店舗または複数商品の抽選まとめ

-   lottery_scheduled

    -   今後開始予定

-   lottery_updated

    -   内容変更

-   deadline_extended

    -   応募期限延長

-   result_announced

    -   当選発表

-   purchase_information

    -   購入期間、受取期間、購入方法

-   lottery_cancelled

    -   抽選中止

-   lottery_preparation

    -   会員登録や購入履歴などの事前準備

-   reservation

    -   予約販売

-   general_sale

    -   通常販売、先着販売

-   restock

    -   再販、再入荷

-   unrelated

    -   対象外

「抽選」という単語だけで抽選情報と判定しないでください。

例えば、以下は lottery_preparation としてください。

-   抽選に備えて
-   抽選をスムーズにするため
-   抽選開始したら
-   会員登録を済ませておきましょう
-   購入履歴を作っておきましょう

以下が含まれる場合は、抽選情報の可能性を高くしてください。

-   抽選開始
-   応募受付中
-   応募期間
-   締切
-   ○ 月 ○ 日まで
-   当選発表
-   購入期限
-   応募はこちら

## 抽出対象

投稿から以下を抽出してください。

### 共通情報

-   cardType

    -   pokemon
    -   onepiece
    -   other
    -   unknown

-   productName
-   storeName
-   storeBranch
-   region
-   postType
-   sourcePostUrl
-   sourcePublishedAt

### 抽選情報

-   applicationStartAt
-   applicationEndAt
-   resultAnnouncementAt
-   purchaseStartAt
-   purchaseDeadlineAt
-   applicationUrl
-   officialInformationUrl
-   appDownloadUrl
-   applicationMethod
-   eligibilityConditions
-   pickupMethod
-   paymentMethod
-   price
-   notes

## 日時の扱い

日時が不完全でも登録できるようにしてください。

各日時について、値とは別に精度と状態を持たせてください。

precision：

-   datetime
-   date_only
-   store_closing_time
-   inferred
-   unknown

status：

-   unknown
-   not_published
-   extracted
-   verified
-   conflicting

例：

「8/11(火)23:59 〆」

投稿日が 2026 年 7 月 24 日で曜日も一致する場合：

applicationEndAt:
2026-08-11T23:59:00+09:00

applicationEndPrecision:
datetime

「11/10 閉店時間〆」の場合：

applicationEndAt:
null

applicationEndDate:
2025-11-10

applicationEndPrecision:
store_closing_time

rawApplicationEndText:
11/10 閉店時間〆

投稿日時を応募開始日時として保存しないでください。

正確な開始日時が不明で、「抽選開始されました」とだけ書かれている場合は次を保存してください。

-   applicationStartAt: null
-   confirmedOpenAt: 投稿日時

年が省略されている場合は、投稿日時、月、曜日から年を推定してください。

推定した場合は、日時精度を inferred にするか、yearInferred フラグを保持してください。

## 複数抽選の分割

1 投稿に複数店舗がある場合は、店舗ごとに分割してください。

1 投稿に複数商品がある場合は、商品ごとに分割してください。

例：

ドラゴンスターで
「世界最強の戦士」
「STORY BOOSTER 01」
の抽選が掲載されている場合、抽選レコードを 2 件生成してください。

セクションが以下のように分かれている場合：

【応募期間】
商品 A 8/11 23:59
商品 B 8/2 23:59

【当選発表日】
商品 A 8/15
商品 B 8/5

商品名をキーにして応募締切と当選発表日を結合してください。

配列順だけに依存せず、可能な限り商品名で対応付けてください。

## URL 分類

URL は以下の種別に分類してください。

-   application
-   official_information
-   app_download
-   membership_registration
-   purchase
-   product
-   x_post
-   image
-   unknown

t.co 短縮 URL だけでなく、ブラウザ上で解決された最終 URL も保存してください。

保存項目：

-   originalUrl
-   resolvedUrl
-   finalUrl
-   domain
-   urlType
-   checkedAt
-   httpStatus

App Store や Google Play の URL は、原則として applicationUrl ではなく appDownloadUrl へ保存してください。

会員登録ページは applicationUrl ではなく membership_registration として扱ってください。

## DB 設計

既存 DB と ORM を確認して、既存方式に合わせてマイグレーションを作成してください。

最低限、以下のテーブルまたは同等構造を用意してください。

### source_posts

X から取得した元投稿。

-   id
-   platform
-   externalPostId
-   authorId
-   authorUsername
-   authorDisplayName
-   bodyRaw
-   publishedAt
-   sourceUrl
-   imageUrls
-   externalUrls
-   rawHtml
-   contentHash
-   fetchedAt
-   deletedAt
-   createdAt
-   updatedAt

externalPostId にユニーク制約を設定してください。

### post_analyses

解析結果。

-   id
-   sourcePostId
-   postType
-   isLotteryInformation
-   cardType
-   confidenceScore
-   analysisStatus
-   parserVersion
-   extractedData
-   analyzedAt
-   errorMessage

### lotteries

ユーザーに表示する抽選本体。

-   id
-   productName
-   normalizedProductName
-   cardType
-   storeName
-   normalizedStoreName
-   storeBranch
-   region
-   applicationStartAt
-   confirmedOpenAt
-   applicationEndAt
-   applicationEndDate
-   applicationEndPrecision
-   resultAnnouncementAt
-   resultAnnouncementDate
-   resultAnnouncementPrecision
-   purchaseStartAt
-   purchaseDeadlineAt
-   applicationUrl
-   officialInformationUrl
-   appDownloadUrl
-   applicationMethod
-   eligibilityConditions
-   pickupMethod
-   paymentMethod
-   price
-   status
-   completenessScore
-   verificationStatus
-   createdAt
-   updatedAt

### lottery_sources

1 つの抽選に複数投稿や公式ページを紐づける。

-   id
-   lotteryId
-   sourcePostId
-   sourceType
-   sourceUrl
-   isPrimary
-   confidenceScore
-   extractedData
-   publishedAt
-   createdAt

### lottery_field_history

項目変更履歴。

-   id
-   lotteryId
-   fieldName
-   oldValue
-   newValue
-   sourcePostId
-   changedAt

## 同一抽選の判定

既存抽選との照合処理を実装してください。

候補判定に使用する項目：

-   正規化商品名
-   正規化店舗名
-   店舗支店
-   地域
-   応募締切
-   応募 URL のドメイン
-   投稿日時との近さ

スコア例：

-   商品名一致：40 点
-   店舗名一致：30 点
-   支店・地域一致：10 点
-   応募締切一致：15 点
-   URL ドメイン一致：5 点

目安：

-   80 点以上：既存抽選へ自動統合
-   50〜79 点：要確認として保存
-   49 点以下：新規抽選候補

ただし、同じ商品と店舗でも抽選回が違う場合があるため、締切日が大きく異なる場合は自動統合しないでください。

判定スコアと判定理由をログまたは DB へ保存してください。

## 情報統合ルール

新しい投稿から情報を取得した場合、既存抽選の空欄を補完してください。

既存値と新しい値が異なる場合は、以下の優先順位を考慮してください。

1. 公式応募ページ
2. 店舗公式サイト
3. 店舗公式 X アカウント
4. 信頼済み情報アカウント
5. その他の投稿

値を更新する場合は、必ず lottery_field_history へ変更履歴を保存してください。

信頼度が低い情報で、信頼度が高い既存情報を自動上書きしないでください。

競合する値がある場合：

-   verificationStatus を conflicting にする
-   既存値を即座に破棄しない
-   両方の情報源を保存する
-   要確認キューへ送る

## 完成度

抽選レコードに completenessScore を設定してください。

例：

-   商品名：必須
-   店舗名：必須
-   応募締切：重要
-   当選発表：重要
-   購入期限：任意
-   応募 URL：重要
-   応募条件：任意
-   公式情報 URL：任意

未公開の項目はエラー扱いにしないでください。

次のように区別してください。

-   まだ公開されていない
-   投稿に記載がない
-   解析できなかった
-   競合している
-   公式確認済み

## 重複実行対策

数分間隔で同じ投稿を取得しても、重複登録されないようにしてください。

-   externalPostId で upsert
-   contentHash で本文変更を検出
-   同一解析バージョンで変更がなければ再解析を省略
-   DB 登録処理をトランザクション化
-   バッチの多重起動を考慮
-   同一投稿の並列処理を防止

投稿本文が編集または変化した場合は、再解析して差分を反映してください。

## ログ

以下を構造化ログで出力してください。

-   batchId
-   tweetId
-   sourcePostId
-   postType
-   extractedLotteryCount
-   matchedLotteryId
-   matchScore
-   action

    -   inserted
    -   updated
    -   skipped
    -   needs_review
    -   failed

-   changedFields
-   error

rawHtml 全文を通常ログへ出さないでください。

## エラー処理

以下の失敗でバッチ全体を停止させないでください。

-   1 投稿の DOM 解析失敗
-   日時解析失敗
-   URL 展開失敗
-   商品名不明
-   店舗名不明
-   DB 登録失敗

投稿単位でエラーを記録し、次の投稿の処理を継続してください。

解析不能な投稿も source_posts には保存してください。

## テスト

以下のケースについて単体テストと統合テストを追加してください。

1. 1 店舗・1 商品の抽選
2. 1 店舗・複数商品の抽選
3. 複数店舗の抽選まとめ
4. 応募締切のみ取得できる
5. 当選発表日が後日投稿される
6. 購入期限が後日投稿される
7. 締切日時が延長される
8. 抽選が中止される
9. 「閉店時間まで」
10. 応募ページ未公開
11. App Store リンクしかない
12. 会員登録の事前準備投稿
13. 再販・通常販売投稿
14. 同じ投稿を複数回取得
15. 同じ商品・店舗の別抽選回
16. 公式情報と第三者投稿が競合
17. 年が省略されている
18. 曜日と推定年が一致しない
19. 「さらに表示」展開前後
20. X の CSS クラスが変わっても data-testid で取得できる

## 実装後の出力

実装完了後、以下を報告してください。

1. 変更したファイル一覧
2. 新規作成したファイル一覧
3. DB マイグレーション内容
4. 投稿分類ロジック
5. 同一抽選判定ロジック
6. 情報統合・上書きルール
7. バッチの実行方法
8. 環境変数
9. テスト実行方法
10. 残っている制約とリスク

既存コードの言語、フレームワーク、ORM、命名規則、エラーハンドリング方式を確認し、既存プロジェクトの方針を優先してください。

不明な部分を勝手に別技術へ置き換えないでください。

まず既存コードを調査し、その後に実装してください。

DB は Turso ＋ API は Cloudflare Workers
