-- Mobile-G2B-Hardening: 論理削除済み重複行の整理手順
--
-- 位置づけ:
-- 現行スキーマ（0000〜0015）は unique(userId, lotteryId/productId/stepId) を
-- `WHERE deleted_at IS NULL` の部分一意インデックスとして定義しており、
-- かつ復元は常に既存行の deletedAt を戻す形で行うため（新規行を作らない）、
-- 通常運用でこのスクリプトが必要になることはない。
-- 万一、過去の不具合・手動データ修正・障害復旧等により
-- 「同一(userId, 対象キー)に対して deleted_at IS NOT NULL の行が複数存在する」
-- 状態が生じた場合の"事後整理"用スクリプトとして用意する。
--
-- 安全ルール:
-- 1. 本スクリプトは自動実行しない。人間が内容を確認し、必ずSELECT（プレビュー）を
--    先に実行してから、問題ないことを確認した上でDELETE文を個別に実行すること。
-- 2. deleted_at IS NULL（有効な行）は対象にしない。部分一意インデックスにより
--    そもそも重複し得ないため、このスクリプトが触れるのは deleted_at IS NOT NULL の
--    行のみ。
-- 3. 各グループについて、最も新しい updated_at を持つ1行のみを残し、
--    それ以外を物理削除する（統計・監査目的で古い削除済み重複を残す必要がある場合は
--    DELETEの前に別テーブルへバックアップすること）。
-- 4. 本番Turso環境で実行する前に、必ずステージング相当の環境でリハーサルすること。

-- ============================================================
-- 1. プレビュー: user_lotteries の重複削除済みグループを確認する
-- ============================================================
SELECT user_id, lottery_id, COUNT(*) AS duplicate_count
FROM user_lotteries
WHERE deleted_at IS NOT NULL
GROUP BY user_id, lottery_id
HAVING COUNT(*) > 1;

-- 実際に削除する行（各グループの最新以外）を確認する
SELECT *
FROM user_lotteries
WHERE deleted_at IS NOT NULL
  AND id NOT IN (
    SELECT MAX(id) FROM user_lotteries
    WHERE deleted_at IS NOT NULL
    GROUP BY user_id, lottery_id
  )
  AND (user_id, lottery_id) IN (
    SELECT user_id, lottery_id FROM user_lotteries
    WHERE deleted_at IS NOT NULL
    GROUP BY user_id, lottery_id
    HAVING COUNT(*) > 1
  );

-- 上記プレビューの内容を確認し、問題なければ以下を実行する（コメントアウト解除）
-- DELETE FROM user_lotteries
-- WHERE deleted_at IS NOT NULL
--   AND id NOT IN (
--     SELECT MAX(id) FROM user_lotteries
--     WHERE deleted_at IS NOT NULL
--     GROUP BY user_id, lottery_id
--   )
--   AND (user_id, lottery_id) IN (
--     SELECT user_id, lottery_id FROM user_lotteries
--     WHERE deleted_at IS NOT NULL
--     GROUP BY user_id, lottery_id
--     HAVING COUNT(*) > 1
--   );

-- ============================================================
-- 2. user_favorites （同じ考え方、キーは user_id, lottery_id）
-- ============================================================
SELECT user_id, lottery_id, COUNT(*) AS duplicate_count
FROM user_favorites
WHERE deleted_at IS NOT NULL
GROUP BY user_id, lottery_id
HAVING COUNT(*) > 1;
-- DELETE文は1.と同じパターンをuser_favoritesへ適用する（省略）

-- ============================================================
-- 3. followed_products （キーは user_id, product_id）
-- ============================================================
SELECT user_id, product_id, COUNT(*) AS duplicate_count
FROM followed_products
WHERE deleted_at IS NOT NULL
GROUP BY user_id, product_id
HAVING COUNT(*) > 1;
-- DELETE文は1.と同じパターンをfollowed_productsへ適用する（省略）

-- ============================================================
-- 4. checklist_progress （キーは user_id, lottery_id, step_id）
-- ============================================================
SELECT user_id, lottery_id, step_id, COUNT(*) AS duplicate_count
FROM checklist_progress
WHERE deleted_at IS NOT NULL
GROUP BY user_id, lottery_id, step_id
HAVING COUNT(*) > 1;
-- DELETE文は1.と同じパターンをchecklist_progressへ適用する（省略）

-- notification_preferences は user_id に完全unique制約（論理削除の概念自体が無い）のため対象外。
