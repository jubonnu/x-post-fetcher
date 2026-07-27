# Turso データベース テーブル一覧

DB URL: `libsql://x-post-fetcher-jubonnu.aws-ap-northeast-1.turso.io`

## テーブル

| テーブル名 | 内容 |
|---|---|
| `source_posts` | スクレイプした X の投稿データ |
| `post_analyses` | 投稿の解析結果（抽選情報の抽出結果） |
| `lotteries` | 抽選情報（正規化・マージ済み） |
| `processing_jobs` | analyze_post ジョブキュー |
| `lottery_sources` | 抽選（lotteries）と投稿（source_posts）の紐付け |
| `lottery_field_history` | 抽選フィールドの変更履歴 |
| `__drizzle_migrations` | マイグレーション管理（システム用、触らない） |

## データの流れ

```
X投稿スクレイプ
  → source_posts（投稿保存）
  → processing_jobs（analyze_post ジョブ登録）
  → post_analyses（ルールベース解析結果）
  → lotteries（抽選情報としてマージ・保存）
  → lottery_sources（投稿と抽選の紐付け）
  → lottery_field_history（フィールド変更ログ）
```

## Turso で中身を確認する方法

Turso dashboard → x-post-fetcher → **Edit Data** タブ → 左サイドバーでテーブルを選択
