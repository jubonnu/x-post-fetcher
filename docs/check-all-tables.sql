-- ============================================================
-- 全テーブル確認用 SQL
-- Turso Dashboard > Edit Data > SQL console に貼り付けて実行
-- ============================================================

-- 1. 件数確認（まずここで全体把握）
SELECT 'source_posts'        AS table_name, COUNT(*) AS count FROM source_posts
UNION ALL
SELECT 'post_analyses',                      COUNT(*) FROM post_analyses
UNION ALL
SELECT 'lotteries',                          COUNT(*) FROM lotteries
UNION ALL
SELECT 'lottery_sources',                    COUNT(*) FROM lottery_sources
UNION ALL
SELECT 'lottery_field_history',              COUNT(*) FROM lottery_field_history
UNION ALL
SELECT 'processing_jobs',                    COUNT(*) FROM processing_jobs;

-- ============================================================

-- 2. source_posts — スクレイプした投稿（最新10件）
SELECT
  id,
  author_username,
  published_at,
  SUBSTR(body_raw, 1, 80) AS body_preview,
  external_urls,
  fetched_at
FROM source_posts
ORDER BY id DESC
LIMIT 14;

-- ============================================================

-- 3. post_analyses — 解析結果（最新10件）
SELECT
  id,
  source_post_id,
  post_type,
  is_lottery_information,
  card_type,
  confidence_score,
  analysis_status,
  SUBSTR(extracted_data, 1, 120) AS extracted_preview,
  analyzed_at
FROM post_analyses
ORDER BY id DESC
LIMIT 10;

-- ============================================================

-- 4. lotteries — 抽選情報（最新10件）
SELECT
  id,
  product_name_raw,
  normalized_product_name,
  card_type,
  store_name_raw,
  application_end_date,
  result_announcement_date,
  application_url,
  completeness_score,
  verification_status,
  lifecycle_status,
  created_at
FROM lotteries
ORDER BY id DESC
LIMIT 10;

-- ============================================================

-- 5. lottery_sources — 抽選と投稿の紐付け（最新20件）
SELECT
  id,
  lottery_id,
  source_post_id,
  match_action,
  match_score,
  match_reason,
  created_at
FROM lottery_sources
ORDER BY id DESC
LIMIT 20;

-- ============================================================

-- 6. lottery_field_history — フィールド変更履歴（最新20件）
SELECT
  id,
  lottery_id,
  source_post_id,
  field_name,
  old_value,
  new_value,
  change_type,
  created_at
FROM lottery_field_history
ORDER BY id DESC
LIMIT 20;

-- ============================================================

-- 7. processing_jobs — ジョブキュー（ステータス別件数）
SELECT
  job_type,
  status,
  COUNT(*) AS count
FROM processing_jobs
GROUP BY job_type, status
ORDER BY job_type, status;

-- 7b. 失敗したジョブの詳細
SELECT
  id,
  job_type,
  status,
  source_post_id,
  attempts,
  last_error,
  created_at
FROM processing_jobs
WHERE status = 'failed'
ORDER BY id DESC
LIMIT 10;
