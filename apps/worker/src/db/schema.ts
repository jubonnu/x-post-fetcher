import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export type JobType = "resolve_urls" | "analyze_post";
export type JobStatus = "pending" | "running" | "done" | "failed";

/**
 * source_posts — X から取得した元投稿（情報源）。
 * Phase 1 の対象テーブル。externalPostId に UNIQUE 制約。
 * 配列（imageUrls / externalUrls）は JSON 文字列で保持する。
 */
export const sourcePosts = sqliteTable(
  "source_posts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    platform: text("platform").notNull().default("x"),
    externalPostId: text("external_post_id").notNull(),
    authorId: text("author_id"),
    authorUsername: text("author_username"),
    authorDisplayName: text("author_display_name"),
    bodyRaw: text("body_raw"),
    publishedAt: text("published_at"),
    sourceUrl: text("source_url"),
    imageUrls: text("image_urls"), // JSON string
    externalUrls: text("external_urls"), // JSON string
    rawHtml: text("raw_html"),
    cleanedHtml: text("cleaned_html"),
    contentHash: text("content_hash"),
    fetchedAt: text("fetched_at"),
    deletedAt: text("deleted_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    externalPostIdUnique: uniqueIndex("source_posts_external_post_id_unique").on(t.externalPostId),
  })
);

export type SourcePostRow = typeof sourcePosts.$inferSelect;
export type SourcePostInsert = typeof sourcePosts.$inferInsert;

/**
 * post_analyses — ルールベース解析結果（Phase 2）。LLM は使用しない。
 * 再解析条件は inputContentHash（= source_posts.content_hash）のみで判定する。
 */
export const postAnalyses = sqliteTable("post_analyses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourcePostId: integer("source_post_id").notNull(),
  postType: text("post_type"),
  isLotteryInformation: integer("is_lottery_information", { mode: "boolean" }),
  cardType: text("card_type"),
  confidenceScore: text("confidence_score"),
  analysisStatus: text("analysis_status"),
  parserVersion: text("parser_version"), // ルールパーサ版（記録用）
  inputContentHash: text("input_content_hash"),
  extractedData: text("extracted_data"), // JSON（抽出結果 + urls）
  analyzedAt: text("analyzed_at"),
  errorMessage: text("error_message"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export type PostAnalysisRow = typeof postAnalyses.$inferSelect;

/**
 * lotteries — ユーザーに表示する抽選本体（Phase 2 は単純 insert、同一判定は Phase 3）。
 * 正規化前 Raw 値を必ず保持。日時は at / date / precision を分離保持。
 */
export const lotteries = sqliteTable("lotteries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourcePostId: integer("source_post_id"),
  productNameRaw: text("product_name_raw"),
  normalizedProductName: text("normalized_product_name"),
  cardType: text("card_type"),
  storeNameRaw: text("store_name_raw"),
  normalizedStoreName: text("normalized_store_name"),
  storeBranchRaw: text("store_branch_raw"),
  normalizedStoreBranch: text("normalized_store_branch"),
  region: text("region"),
  normalizerVersion: text("normalizer_version"),
  applicationStartAt: text("application_start_at"),
  confirmedOpenAt: text("confirmed_open_at"),
  applicationEndAt: text("application_end_at"),
  applicationEndDate: text("application_end_date"),
  applicationEndPrecision: text("application_end_precision"),
  resultAnnouncementAt: text("result_announcement_at"),
  resultAnnouncementDate: text("result_announcement_date"),
  resultAnnouncementPrecision: text("result_announcement_precision"),
  purchaseStartAt: text("purchase_start_at"),
  purchaseDeadlineAt: text("purchase_deadline_at"),
  applicationUrl: text("application_url"),
  resolvedApplicationUrl: text("resolved_application_url"),
  applicationUrlHttpStatus: integer("application_url_http_status"),
  urlResolvedAt: text("url_resolved_at"),
  officialInformationUrl: text("official_information_url"),
  appDownloadUrl: text("app_download_url"),
  applicationMethod: text("application_method"),
  eligibilityConditions: text("eligibility_conditions"),
  pickupMethod: text("pickup_method"),
  paymentMethod: text("payment_method"),
  price: text("price"),
  status: text("status"),
  completenessScore: text("completeness_score"),
  verificationStatus: text("verification_status"),
  // Phase 5: 承認/却下
  approvedBy: text("approved_by"),
  approvedAt: text("approved_at"),
  rejectedReason: text("rejected_reason"),
  rejectedAt: text("rejected_at"),
  // Phase 6 (hardening): ライフサイクル管理（物理削除なし）
  lifecycleStatus: text("lifecycle_status").notNull().default("active"), // active / orphaned / archived
  orphanedAt: text("orphaned_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export type LotteryRow = typeof lotteries.$inferSelect;
export type LotteryInsert = typeof lotteries.$inferInsert;

/**
 * lottery_sources — 1つの抽選に寄与した情報源（source_posts）を記録（Phase 3）。
 * 同一抽選マッチングで複数投稿が同じ抽選に統合された場合、どの投稿が寄与したかを保持する。
 */
export const lotterySources = sqliteTable("lottery_sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lotteryId: integer("lottery_id").notNull(),
  sourcePostId: integer("source_post_id").notNull(),
  matchAction: text("match_action"), // new / merge / review
  matchScore: text("match_score"),
  matchReason: text("match_reason"),
  contributedFields: text("contributed_fields"), // JSON: 反映したフィールド名の配列
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export type LotterySourceRow = typeof lotterySources.$inferSelect;

/**
 * lottery_field_history — 抽選フィールドの変更履歴（Phase 3）。
 * created（新規）/ updated（空欄補完・上書き）/ conflicting（競合で不採用）を記録する。
 */
export const lotteryFieldHistory = sqliteTable("lottery_field_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lotteryId: integer("lottery_id").notNull(),
  sourcePostId: integer("source_post_id"),
  fieldName: text("field_name").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changeType: text("change_type").notNull(), // created / updated / conflicting
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export type LotteryFieldHistoryRow = typeof lotteryFieldHistory.$inferSelect;

/**
 * processing_jobs — 非同期・リトライ可能なジョブ管理（Phase 4）。
 * jobType: 'resolve_urls'（URL 解決）| 'analyze_post'（再解析）
 * status: pending → running → done / failed（失敗時は attempts < maxAttempts なら pending に戻す）
 */
export const processingJobs = sqliteTable("processing_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobType: text("job_type").notNull(),
  status: text("status").notNull().default("pending"),
  sourcePostId: integer("source_post_id"),
  lotteryId: integer("lottery_id"),
  payload: text("payload"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  nextRetryAt: text("next_retry_at"),
  lastError: text("last_error"),
  lockedAt: text("locked_at"),
  lockedBy: text("locked_by"),
  completedAt: text("completed_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export type ProcessingJobRow = typeof processingJobs.$inferSelect;

/**
 * users — Mobile-G2A: 認証済みユーザー。
 * `id`（内部integer主キー）はDB内のFK参照専用で、外部（JWT sub / RevenueCat App User ID /
 * APIレスポンス）には絶対に出力しない。外部公開用の識別子は `publicUserId`（UUIDv4）。
 * Appleの `sub` はここではなく `user_identities.providerUserId` に正規化して持つ。
 */
export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicUserId: text("public_user_id").notNull(),
    displayName: text("display_name"),
    email: text("email"),
    emailIsPrivateRelay: integer("email_is_private_relay", { mode: "boolean" }),
    // active / pending_deletion / deleted
    accountStatus: text("account_status").notNull().default("active"),
    deletionRequestedAt: text("deletion_requested_at"),
    scheduledDeletionAt: text("scheduled_deletion_at"),
    lastLoginAt: text("last_login_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    deletedAt: text("deleted_at"),
  },
  (t) => ({
    publicUserIdUnique: uniqueIndex("users_public_user_id_unique").on(t.publicUserId),
    accountStatusIdx: index("users_account_status_idx").on(t.accountStatus),
  })
);

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;

/**
 * user_identities — 認証プロバイダごとの外部ID紐付け（Apple `sub` 等）。
 * 1ユーザーが複数プロバイダ（将来のGoogle等）を持てるよう正規化する。
 *
 * `appleRefreshTokenCiphertext`系は、`authorizationCode`をApple側トークンエンドポイントと
 * 交換して得たApple Refresh Tokenを、AES-256-GCMで暗号化して保存する（Mobile-G2A-Hardening）。
 * DBには暗号文のみを保存し、生の値は保存しない。`appleRefreshTokenKeyVersion`は
 * 暗号化に使った鍵の世代（`APPLE_TOKEN_ENCRYPTION_KEY_VERSION`等とのローテーション対応用）。
 * アカウント削除時のApple側トークン失効にのみ使用し、日常の認証フローでは使わない。
 */
export const userIdentities = sqliteTable(
  "user_identities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    provider: text("provider").notNull(), // 'apple' | 将来 'google' | 'email'
    providerUserId: text("provider_user_id").notNull(), // Appleの sub
    email: text("email"), // サインイン時点でプロバイダから受領した値
    appleRefreshTokenCiphertext: text("apple_refresh_token_ciphertext"), // Base64、暗号文のみ
    appleRefreshTokenIv: text("apple_refresh_token_iv"), // Base64、AES-GCM用IV（12byte）
    appleRefreshTokenKeyVersion: text("apple_refresh_token_key_version"), // 暗号化に使った鍵の世代
    appleTokenObtainedAt: text("apple_token_obtained_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    providerUnique: uniqueIndex("user_identities_provider_unique").on(t.provider, t.providerUserId),
    userIdIdx: index("user_identities_user_id_idx").on(t.userId),
  })
);

export type UserIdentityRow = typeof userIdentities.$inferSelect;
export type UserIdentityInsert = typeof userIdentities.$inferInsert;

/**
 * refresh_tokens — Refresh Tokenのローテーション・失効管理。
 * 生トークンは保存せず `tokenHash`（SHA-256）のみ保持する。
 * `rotatedFromId` でローテーション連鎖を追跡し、失効済みトークンの再送を
 * 「盗難の兆候」として検知する（再利用検知時は該当userIdの全行を失効させる）。
 */
export const refreshTokens = sqliteTable(
  "refresh_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    deviceId: text("device_id").notNull(),
    deviceName: text("device_name"),
    rotatedFromId: integer("rotated_from_id"),
    issuedAt: text("issued_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
    // 'rotated' | 'logout' | 'logout_all' | 'reuse_detected' | 'account_deleted'
    revokedReason: text("revoked_reason"),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex("refresh_tokens_token_hash_unique").on(t.tokenHash),
    userIdIdx: index("refresh_tokens_user_id_idx").on(t.userId),
    deviceIdIdx: index("refresh_tokens_device_id_idx").on(t.deviceId),
  })
);

export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type RefreshTokenInsert = typeof refreshTokens.$inferInsert;

/**
 * audit_logs — 認証・アカウント操作の監査ログ。物理削除しない。
 * トークンや個人情報の生値は書き込まない（`detailJson` にも含めない）。
 */
export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id"),
    action: text("action").notNull(),
    detailJson: text("detail_json"),
    ipHash: text("ip_hash"),
    requestId: text("request_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    userIdIdx: index("audit_logs_user_id_idx").on(t.userId),
  })
);

export type AuditLogRow = typeof auditLogs.$inferSelect;
export type AuditLogInsert = typeof auditLogs.$inferInsert;

/**
 * account_deletion_requests — 猶予期間付きアカウント削除の状態管理。
 * `DELETE /me` は即時物理削除ではなくこの行を作成し `users.accountStatus` を
 * pending_deletion にするのみ。猶予期間経過後の物理削除バッチは
 * `repositories/accountDeletionRepository.ts` の `hardDeleteUserAccount`
 * （`services/accountHardDeletionService.ts` 経由、Cron Trigger実行、Mobile-G2A残修正）。
 * `pending_deletion` 中に再サインインした場合は `cancelPendingAccountDeletion` が
 * `status` を cancelled にし `users.accountStatus` を active へ戻す。
 *
 * `appleRevocationStatus`系（Mobile-G2A-Hardening）:
 * CardHub側のアカウント削除自体はApple側の失効結果を待たずに完了させる
 * （ベストエフォート、Apple APIの一時障害でユーザー自身の削除操作をブロックしないため）。
 * Apple側トークン失効の状態はこの行で独立して追跡し、失敗時は再試行できるようにする。
 * - not_applicable: Apple識別子が無い、またはApple Refresh Token自体を保持していない
 * - pending: これから試行する（新規行のデフォルトは`not_applicable`。Cron再試行対象は`failed_will_retry`）
 * - processing: Cron再試行が処理中（二重処理防止のための一時的なクレーム状態、条件付きUPDATEで排他）
 * - succeeded: 失効成功（Apple側が既に無効と回答した場合も含む）
 * - failed_will_retry: 失敗したが再試行余地あり（`appleRevocationNextRetryAt`以降に再試行対象になる）
 * - failed_permanently: 最大試行回数を超えた
 */
export const accountDeletionRequests = sqliteTable(
  "account_deletion_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    requestedAt: text("requested_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    scheduledDeletionAt: text("scheduled_deletion_at").notNull(),
    // pending / cancelled / completed
    status: text("status").notNull().default("pending"),
    cancelledAt: text("cancelled_at"),
    completedAt: text("completed_at"),
    reason: text("reason"),
    appleRevocationStatus: text("apple_revocation_status").notNull().default("not_applicable"),
    appleRevocationAttempts: integer("apple_revocation_attempts").notNull().default(0),
    appleRevocationLastAttemptAt: text("apple_revocation_last_attempt_at"),
    appleRevocationLastError: text("apple_revocation_last_error"),
    /** 次回Cron再試行の予定時刻（指数バックオフ）。これ以前は再試行対象に含めない。 */
    appleRevocationNextRetryAt: text("apple_revocation_next_retry_at"),
    /**
     * processing状態に入った時刻（Mobile-G2A残修正: stale processing回収）。
     * この時刻から`APPLE_REVOCATION_PROCESSING_TIMEOUT_MINUTES`以上経過していれば
     * staleとみなし、別のWorkerが再クレーム可能にする。
     */
    appleRevocationProcessingStartedAt: text("apple_revocation_processing_started_at"),
    /**
     * クレーム保持者を識別するランダムトークン（claimしたWorkerだけがランダムUUIDを設定）。
     * 処理結果の書き込みは必ず`WHERE claimId = 自分が取得したclaimId`を条件に含めることで、
     * stale判定により別のWorkerに再クレームされた後、古いWorkerが遅れて完了報告しても
     * 新しい処理結果を上書きしない（fencing token方式）。
     */
    appleRevocationClaimId: text("apple_revocation_claim_id"),
  },
  (t) => ({
    userIdIdx: index("account_deletion_requests_user_id_idx").on(t.userId),
    appleRevocationStatusIdx: index("account_deletion_requests_apple_revocation_status_idx").on(
      t.appleRevocationStatus
    ),
  })
);

export type AccountDeletionRequestRow = typeof accountDeletionRequests.$inferSelect;
export type AccountDeletionRequestInsert = typeof accountDeletionRequests.$inferInsert;

/**
 * products — 商品マスタ（Mobile-G2B-1）。既存`lotteries.normalizedProductName`は
 * バックエンドに商品としての正式な同一性概念を持たない（クライアント側で文字列グルーピング
 * していただけ）ため新設する。既存`lotteries`系テーブルへの変更は一切ない。
 *
 * `lifecycleStatus`と`mergedIntoProductId`は必ずセットで更新すること
 * （'merged'になった行は`mergedIntoProductId`を必ず持つ、逆に非nullなら'merged'であるべき、
 * という不変条件をアプリケーション側で維持する。DB制約では自己参照のみ禁止する）。
 * G2B-1では統合を行うUI・管理APIは実装しない（スキーマとして可能にするのみ）。
 */
export const products = sqliteTable(
  "products",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicProductId: text("public_product_id").notNull(),
    canonicalName: text("canonical_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    normalizerVersion: text("normalizer_version"),
    // active / merged / archived（'archived'はG2B-1では未使用、将来予約）
    lifecycleStatus: text("lifecycle_status").notNull().default("active"),
    mergedIntoProductId: integer("merged_into_product_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    publicProductIdUnique: uniqueIndex("products_public_product_id_unique").on(t.publicProductId),
    normalizedNameIdx: index("products_normalized_name_idx").on(t.normalizedName),
    lifecycleStatusIdx: index("products_lifecycle_status_idx").on(t.lifecycleStatus),
    lifecycleStatusCheck: check(
      "products_lifecycle_status_check",
      sql`${t.lifecycleStatus} IN ('active', 'merged', 'archived')`
    ),
    noSelfMergeCheck: check(
      "products_no_self_merge_check",
      sql`${t.mergedIntoProductId} IS NULL OR ${t.mergedIntoProductId} != ${t.id}`
    ),
  })
);

export type ProductRow = typeof products.$inferSelect;
export type ProductInsert = typeof products.$inferInsert;

/**
 * product_aliases — 商品の別名（正規化済み文字列）→商品IDの解決キー（Mobile-G2B-1）。
 *
 * unique制約は`(normalizedAlias, normalizerVersion)`の複合とする（`productId`は含めない）。
 * 理由: 「この別名文字列＋このバージョンの正規化ロジックが生成した値」は常に1つの商品を
 * 指す、という不変条件をDB制約で保証するため。`productId`を制約に含めると、同じ
 * (normalizedAlias, normalizerVersion) の組が異なる商品に対して複数存在できてしまい、
 * 解決が本質的に非一意になる（詳細: docs/mobile-g2b-user-data-sync-plan.md 20-5節）。
 *
 * 一方で同じ別名文字列は、異なる`normalizerVersion`の下では独立した別行として存在できる
 * （将来正規化ロジックが変わり、無関係な別商品が偶然同じ文字列に正規化されても、
 * バージョンが異なれば制約違反にならず正しく別商品として扱える）。
 *
 * 【同じnormalizedAliasを別productへ関連付ける必要が生じた場合の移行方法】
 * (normalizedAlias, normalizerVersion) の組は常に1行しか存在しないため、「付け替え」は
 * 新規行の追加ではなく、既存のその1行の`productId`列を直接UPDATEする操作になる
 * （制約違反は起きない）。人手による訂正操作であり、`audit_logs`（G2A実装済み）へ
 * `action: 'product_alias_repointed'`等で記録することを推奨する（本フェーズでは未自動化）。
 */
export const productAliases = sqliteTable(
  "product_aliases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    productId: integer("product_id").notNull(),
    aliasName: text("alias_name").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    normalizerVersion: text("normalizer_version"),
    // initial_migration / re_normalization / manual_merge
    source: text("source").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    normalizedAliasVersionUnique: uniqueIndex("product_aliases_normalized_alias_version_unique").on(
      t.normalizedAlias,
      t.normalizerVersion
    ),
    productIdIdx: index("product_aliases_product_id_idx").on(t.productId),
  })
);

export type ProductAliasRow = typeof productAliases.$inferSelect;
export type ProductAliasInsert = typeof productAliases.$inferInsert;

/**
 * lottery_products — 抽選と商品の対応（Mobile-G2B-1）。
 * 将来「1抽選に複数商品」を許容する中間テーブルとして設計する
 * （`unique(lotteryId)`単独ではなく`unique(lotteryId, productId)`の複合制約）。
 * 初期バックフィルでは原則1抽選1商品（1行のみ）を作成するが、スキーマ上は
 * 複数行を妨げない。既存`lotteries`テーブルへの変更はない（このテーブルからの参照のみ）。
 */
export const lotteryProducts = sqliteTable(
  "lottery_products",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lotteryId: integer("lottery_id").notNull(),
    productId: integer("product_id").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    lotteryProductUnique: uniqueIndex("lottery_products_lottery_product_unique").on(t.lotteryId, t.productId),
    productIdIdx: index("lottery_products_product_id_idx").on(t.productId),
  })
);

export type LotteryProductRow = typeof lotteryProducts.$inferSelect;
export type LotteryProductInsert = typeof lotteryProducts.$inferInsert;

/**
 * user_lotteries — 「自分の抽選」（Mobile-G2B-2）。既存`lotteries`は参照のみ（変更なし）。
 * `serverVersion`はCAS（条件付きUPDATE）による楽観的ロック用（G2Aのrefresh_token
 * ローテーション・Apple失効クレームと同じパターン）。
 *
 * 冪等性はG2B-Hardeningにより`idempotency_records`台帳へ一元化した（行ごとの単一スロット
 * `lastClientRequestId`方式は、古い操作の遅延再送を検知できない欠陥があったため廃止した:
 * 追加(A)→削除(B)の後にAが遅延再送されると、単一スロットは既にBへ上書き済みのため
 * Aを「既知の古い操作」と認識できず、削除済みデータを誤って復元してしまう。台帳方式は
 * 各clientRequestIdを恒久的に記録するため、この種の遅延再送を確実に検知できる）。
 *
 * 一意制約は`(userId, lotteryId)`の**部分一意インデックス**（`deletedAt IS NULL`）とする。
 * 論理削除後は同じ組が複数行存在しうる（削除済み行を再利用せず、常に`deletedAt`を戻して
 * 復元する運用のため実際には増えないが、制約としては削除済み行を許容する）。
 * 復元は必ず既存行の`deletedAt`を戻す形で行い、新規行を作らない（行IDを維持し、
 * `user_lottery_status_history.userLotteryId`等の参照先を壊さない）。
 */
export const userLotteries = sqliteTable(
  "user_lotteries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    lotteryId: integer("lottery_id").notNull(),
    // unknown / planned / applied / won / lost / purchased / skipped
    status: text("status").notNull().default("unknown"),
    snapshotJson: text("snapshot_json"),
    snapshotUpdatedAt: text("snapshot_updated_at"),
    savedAt: text("saved_at").notNull(),
    serverVersion: integer("server_version").notNull().default(1),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    deletedAt: text("deleted_at"),
  },
  (t) => ({
    userLotteryUnique: uniqueIndex("user_lotteries_user_lottery_unique")
      .on(t.userId, t.lotteryId)
      .where(sql`${t.deletedAt} IS NULL`),
    userIdIdx: index("user_lotteries_user_id_idx").on(t.userId),
    userIdStatusIdx: index("user_lotteries_user_id_status_idx").on(t.userId, t.status),
  })
);

export type UserLotteryRow = typeof userLotteries.$inferSelect;
export type UserLotteryInsert = typeof userLotteries.$inferInsert;

/**
 * user_lottery_status_history — 状態遷移履歴（統計の元データ・監査用、Mobile-G2B-2）。
 * 追加型（物理削除しない）。`user_lotteries`が論理削除されても履歴は残す。
 */
export const userLotteryStatusHistory = sqliteTable(
  "user_lottery_status_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userLotteryId: integer("user_lottery_id").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    changedAt: text("changed_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 'user' / 'sync_merge'
    source: text("source").notNull(),
  },
  (t) => ({
    userLotteryIdIdx: index("user_lottery_status_history_user_lottery_id_idx").on(t.userLotteryId),
    changedAtIdx: index("user_lottery_status_history_changed_at_idx").on(t.changedAt),
  })
);

export type UserLotteryStatusHistoryRow = typeof userLotteryStatusHistory.$inferSelect;
export type UserLotteryStatusHistoryInsert = typeof userLotteryStatusHistory.$inferInsert;

/**
 * user_favorites — お気に入り（Mobile-G2B-3）。`serverVersion`は付与しない
 * （20-1節の確定方針: 単純な追加・削除のためunique制約＋論理削除で十分）。
 * 冪等性は`idempotency_records`台帳で行う（G2B-Hardening、`user_lotteries`と同じ理由）。
 */
export const userFavorites = sqliteTable(
  "user_favorites",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    lotteryId: integer("lottery_id").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    deletedAt: text("deleted_at"),
  },
  (t) => ({
    userLotteryUnique: uniqueIndex("user_favorites_user_lottery_unique")
      .on(t.userId, t.lotteryId)
      .where(sql`${t.deletedAt} IS NULL`),
    userIdIdx: index("user_favorites_user_id_idx").on(t.userId),
  })
);

export type UserFavoriteRow = typeof userFavorites.$inferSelect;
export type UserFavoriteInsert = typeof userFavorites.$inferInsert;

/**
 * followed_products — 商品フォロー（Mobile-G2B-3）。G1 4.8節の`productKey`文字列案から
 * `productId`参照に変更（G2B-1で安定した商品マスタが存在するため、20-3節の確定方針）。
 */
export const followedProducts = sqliteTable(
  "followed_products",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    productId: integer("product_id").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    deletedAt: text("deleted_at"),
  },
  (t) => ({
    userProductUnique: uniqueIndex("followed_products_user_product_unique")
      .on(t.userId, t.productId)
      .where(sql`${t.deletedAt} IS NULL`),
    userIdIdx: index("followed_products_user_id_idx").on(t.userId),
  })
);

export type FollowedProductRow = typeof followedProducts.$inferSelect;
export type FollowedProductInsert = typeof followedProducts.$inferInsert;

/**
 * checklist_progress — チェックリスト進捗（Mobile-G2B-4）。stepId単位で行を持つ
 * （JSON列にせず正規化する。端末Aと端末Bで別項目を独立更新する競合解決をシンプルにするため）。
 *
 * `serverVersion`は必須（20-1節）。`clientActionAt`は参考値のみで競合判定には使わない、
 * `serverReceivedAt`は監査専用（10章で確定した競合解決方針）。
 */
export const checklistProgress = sqliteTable(
  "checklist_progress",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    lotteryId: integer("lottery_id").notNull(),
    stepId: text("step_id").notNull(),
    label: text("label").notNull(),
    done: integer("done", { mode: "boolean" }).notNull().default(false),
    completedAt: text("completed_at"),
    completedNote: text("completed_note"),
    sortOrder: integer("sort_order").notNull().default(0),
    serverVersion: integer("server_version").notNull().default(1),
    clientActionAt: text("client_action_at"),
    serverReceivedAt: text("server_received_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    deletedAt: text("deleted_at"),
  },
  (t) => ({
    userLotteryStepUnique: uniqueIndex("checklist_progress_user_lottery_step_unique")
      .on(t.userId, t.lotteryId, t.stepId)
      .where(sql`${t.deletedAt} IS NULL`),
    userLotteryIdx: index("checklist_progress_user_lottery_idx").on(t.userId, t.lotteryId),
  })
);

export type ChecklistProgressRow = typeof checklistProgress.$inferSelect;
export type ChecklistProgressInsert = typeof checklistProgress.$inferInsert;

/**
 * idempotency_records — G2B全体の冪等性台帳（Mobile-G2B-4で導入、G2B-Hardeningで全書き込み系
 * エンドポイントへ一元化）。行ごとの単一スロット方式（旧`lastClientRequestId`列、廃止済み）は
 * 「同じclientRequestIdを別の対象・別操作へ誤用した場合」を検知できず、さらに致命的な欠陥として
 * 「古い操作の遅延再送」を防げなかった（例: 追加(A)→削除(B)の後にAが遅延再送されると、
 * 単一スロットは既にBへ上書き済みのためAを古い操作と認識できず、削除済みデータを誤って
 * 復元してしまう）。台帳は各`(userId, scope, clientRequestId)`を恒久的に記録するため、
 * 後続の別操作に上書きされることなくAを検知でき、この種の遅延再送を確実に防げる。
 *
 * `requestHash`が一致すれば前回のレスポンスをそのまま返す（安全な再送、DBは変更しない）。
 * 一致しなければ`IDEMPOTENCY_CONFLICT`（同一IDを別payload/別操作種別/別対象へ誤用した疑い）
 * として拒否する。台帳への記録は対象データの更新と同一トランザクションで行う
 * （`services/idempotencyLedger.ts`の`runIdempotent`。台帳だけ、または対象データだけが
 * 残る中間状態を作らない）。保持期間は`createdAt`から算出する（本フェーズではCronによる
 * 自動削除は未実装、`services/idempotencyLedger.ts`の定数を参照）。
 */
export const idempotencyRecords = sqliteTable(
  "idempotency_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    // 対象の種類（将来checklist以外にも拡張できるようスコープを持たせる）
    scope: text("scope").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    responseJson: text("response_json").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    scopeRequestUnique: uniqueIndex("idempotency_records_scope_request_unique").on(t.userId, t.scope, t.clientRequestId),
  })
);

export type IdempotencyRecordRow = typeof idempotencyRecords.$inferSelect;
export type IdempotencyRecordInsert = typeof idempotencyRecords.$inferInsert;

/**
 * notification_preferences — 通知設定（Mobile-G2B-5）。1ユーザー1行。
 * `serverVersion`必須（20-1節）。競合解決は自動マージせず`serverVersion`によるCASのみ
 * （G1の「updatedAt優先」案から改訂、計画書11章）。物理削除・論理削除の概念は無い
 * （行が無ければ「未設定＝仮想デフォルト」として扱う。初回GETではDBへ書き込まない）。
 */
export const notificationPreferences = sqliteTable(
  "notification_preferences",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    deadlineReminder: integer("deadline_reminder", { mode: "boolean" }).notNull(),
    announcementReminder: integer("announcement_reminder", { mode: "boolean" }).notNull(),
    purchaseReminder: integer("purchase_reminder", { mode: "boolean" }).notNull(),
    newLotteryAlert: integer("new_lottery_alert", { mode: "boolean" }).notNull(),
    favoriteUpdateAlert: integer("favorite_update_alert", { mode: "boolean" }).notNull(),
    pushEnabled: integer("push_enabled", { mode: "boolean" }).notNull(),
    emailEnabled: integer("email_enabled", { mode: "boolean" }).notNull(),
    quietHoursEnabled: integer("quiet_hours_enabled", { mode: "boolean" }).notNull(),
    quietHoursStart: text("quiet_hours_start"),
    quietHoursEnd: text("quiet_hours_end"),
    deadlineReminderHoursBefore: integer("deadline_reminder_hours_before").notNull(),
    announcementReminderHoursBefore: integer("announcement_reminder_hours_before").notNull(),
    purchaseReminderHoursBefore: integer("purchase_reminder_hours_before").notNull(),
    serverVersion: integer("server_version").notNull().default(1),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    userIdUnique: uniqueIndex("notification_preferences_user_id_unique").on(t.userId),
  })
);

export type NotificationPreferencesRow = typeof notificationPreferences.$inferSelect;
export type NotificationPreferencesInsert = typeof notificationPreferences.$inferInsert;

/**
 * subscription_entitlements — RevenueCat premium認可の正（Mobile-G4）。1ユーザー1行、常に
 * 最新状態へupsertする。premium API保護（`requirePremium`）は必ずこのテーブルを参照し、
 * クライアントのCustomerInfo・RevenueCat entitlementの自己申告を信頼しない。
 *
 * `subscriptions`（購入履歴・期間管理）テーブルは今回追加しない。現時点では
 * 「現在の認可状態」（本テーブル）と「イベント監査・冪等性」（`revenuecat_events`）の
 * 2テーブルで要件を満たせるため、履歴管理が実際に必要になった時点で改めて追加する。
 */
export const subscriptionEntitlements = sqliteTable(
  "subscription_entitlements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    // RevenueCat Dashboardで設定したentitlement識別子（固定値'premium'を想定）。
    entitlementId: text("entitlement_id").notNull(),
    premiumActive: integer("premium_active", { mode: "boolean" }).notNull().default(false),
    // 'cardhub_premium_monthly' / 'cardhub_premium_lifetime' 等
    productId: text("product_id"),
    // 'monthly' / 'lifetime' 等、機能差は設けない（表示・分析用の非正規化情報）
    productType: text("product_type"),
    // 'SANDBOX' / 'PRODUCTION'（RevenueCatのenvironment値をそのまま保持）
    environment: text("environment"),
    // RevenueCatのStore型（'APP_STORE'等）をそのまま保持
    store: text("store"),
    originalTransactionId: text("original_transaction_id"),
    purchasedAt: text("purchased_at"),
    // lifetimeはnull固定
    expiresAt: text("expires_at"),
    // 'PURCHASED' / 'FAMILY_SHARED' / 'UNKNOWN'（RevenueCatのOwnershipType）
    ownershipType: text("ownership_type"),
    // 必ず`toEventTimestamp`（revenuecatWebhookProcessor.ts）が生成したUTC固定形式
    // （YYYY-MM-DDTHH:mm:ss.sssZ）の文字列。Webhookイベント順序逆転ガードが辞書式文字列比較
    // でこの列を使うため、この形式以外の値を書き込まないこと。
    lastRevenueCatEventAt: text("last_revenue_cat_event_at"),
    // このentitlement状態を最後に更新した経路（'webhook' / 'refresh'等）
    source: text("source"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    userIdUnique: uniqueIndex("subscription_entitlements_user_id_unique").on(t.userId),
  })
);

export type SubscriptionEntitlementRow = typeof subscriptionEntitlements.$inferSelect;
export type SubscriptionEntitlementInsert = typeof subscriptionEntitlements.$inferInsert;

/**
 * revenuecat_events — RevenueCat Webhookの冪等性・監査用（Mobile-G4）。
 * `revenueCatEventId`のunique制約で同一イベントの重複処理をDBレベルで防ぐ。
 * `rawPayload`は保持しない方針（22章の通り、必要最小限のみ抽出して保存する）代わりに
 * `payloadHash`で「同じevent.idで内容が違う再送」を検知できるようにする。
 */
export const revenuecatEvents = sqliteTable(
  "revenuecat_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    revenueCatEventId: text("revenue_cat_event_id").notNull(),
    eventType: text("event_type").notNull(),
    appUserId: text("app_user_id").notNull(),
    originalAppUserId: text("original_app_user_id"),
    // JSON文字列化したaliases配列（存在する場合のみ）
    aliasesJson: text("aliases_json"),
    // TRANSFERイベント専用（Mobile-G4 Hardening、自動再試行対応）。JSON文字列化した
    // transferred_from/transferred_to配列。rawPayload全体は保持しない方針のため、
    // 再試行に必要な最小限のコンテキストのみをこの2列へ保存する。TRANSFER以外は常にnull。
    transferredFromJson: text("transferred_from_json"),
    transferredToJson: text("transferred_to_json"),
    environment: text("environment").notNull(),
    eventTimestamp: text("event_timestamp").notNull(),
    payloadHash: text("payload_hash").notNull(),
    // 'processed' / 'ignored_unknown_user' / 'ignored_unknown_event' / 'conflict' / 'error'
    processingStatus: text("processing_status").notNull().default("pending"),
    processedAt: text("processed_at"),
    errorCode: text("error_code"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    eventIdUnique: uniqueIndex("revenuecat_events_event_id_unique").on(t.revenueCatEventId),
    userIdIdx: index("revenuecat_events_app_user_id_idx").on(t.appUserId),
  })
);

export type RevenuecatEventRow = typeof revenuecatEvents.$inferSelect;
export type RevenuecatEventInsert = typeof revenuecatEvents.$inferInsert;
