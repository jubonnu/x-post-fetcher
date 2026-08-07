import type { Db, DbEnv } from "./db/client.ts";
import type { AdminAuthRuntimeConfig } from "./adminAuth/config.ts";
import type { AuthRuntimeConfig } from "./auth/config.ts";

/** Worker が参照する環境変数（Workers Bindings / Node process.env） */
export interface Env extends DbEnv {
  /** /ingest の Bearer トークン */
  INGEST_TOKEN?: string;
  /** 公開GET API（/lotteries系）へのCORSを許可するWeb Originのカンマ区切りリスト（本番/ステージング用）。 */
  PUBLIC_WEB_ORIGINS?: string;

  /**
   * 実行環境識別子。'development' | 'test' | 'preview' | 'production' のみ許可。
   * 未設定・不正値は認証機能全体をfail-closed（503 AUTH_NOT_CONFIGURED）にする（Mobile-G2A-Hardening）。
   */
  ENVIRONMENT?: string;

  /**
   * Sign in with Apple の identityToken 検証に使う audience（aud）。
   * CardHubモバイルアプリの Bundle Identifier（または Services ID）。正式値は未確定のため
   * 開発/テストではプレースホルダーで構成し、本番では未設定時に明確に失敗させる（Mobile-G2A）。
   */
  APPLE_CLIENT_ID?: string;

  /** Access Token(JWT)署名鍵（現行世代）。kid付きでローテーション可能にする（Mobile-G2A）。 */
  JWT_SIGNING_KEY_CURRENT_KID?: string;
  JWT_SIGNING_KEY_CURRENT_SECRET?: string;
  /** 直前世代の署名鍵（ローテーション期間中のみ検証に使用、発行には使わない）。 */
  JWT_SIGNING_KEY_PREVIOUS_KID?: string;
  JWT_SIGNING_KEY_PREVIOUS_SECRET?: string;

  /** アカウント削除の猶予期間（日数）。未設定時は既定値を使う（正式な日数は未確定、Mobile-G1 18章）。 */
  ACCOUNT_DELETION_GRACE_DAYS?: string;

  /**
   * Apple失効再試行のprocessingクレームをstale（Workerが強制終了した等で取り残された）と
   * みなすまでの分数（Mobile-G2A残修正）。未設定時は既定値（30分）を使う。
   */
  APPLE_REVOCATION_PROCESSING_TIMEOUT_MINUTES?: string;

  /**
   * Apple authorizationCode交換・Apple側トークン失効用の設定（Mobile-G2A-Hardening）。
   * 4つとも未設定の場合、この機能自体を無効化する（ログイン・削除は従来通り継続、
   * Apple側との連携のみスキップされるベストエフォート機能のため）。1つでも設定する場合は
   * 4つとも揃える必要がある（`resolveAppleTokenExchangeConfig` が検証する）。
   */
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  /** Sign in with Apple用秘密鍵（.p8の中身、PEM形式）。Cloudflare Secretsのみで管理し、リポジトリへ含めない。 */
  APPLE_PRIVATE_KEY?: string;
  /** Apple Refresh Token暗号化鍵（Base64、32byte/AES-256-GCM用）。現行世代。 */
  APPLE_TOKEN_ENCRYPTION_KEY?: string;
  /** 現行鍵の世代タグ（未設定時は 'v1'）。 */
  APPLE_TOKEN_ENCRYPTION_KEY_VERSION?: string;
  /** ローテーション中のみ設定する直前世代の暗号鍵（復号にのみ使用）。 */
  APPLE_TOKEN_ENCRYPTION_KEY_PREVIOUS?: string;
  APPLE_TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION?: string;

  /**
   * RevenueCat Webhook認証用の共有シークレット（Mobile-G4）。RevenueCat Dashboardの
   * Webhook設定で「Authorization header」として設定した値と一致させる。未設定の間は
   * `POST /webhooks/revenuecat`自体を503 BILLING_NOT_CONFIGUREDにする（fail-closed）。
   */
  REVENUECAT_WEBHOOK_AUTH_HEADER?: string;
  /**
   * Webhookペイロードの HMAC-SHA256 署名検証用シークレット（任意・追加の防御層）。
   * RevenueCatが実際にHMAC署名ヘッダを送るかは要確認のため、未設定ならこの検証自体を
   * スキップする（Authorization headerの一致のみで認証する）。
   */
  REVENUECAT_WEBHOOK_HMAC_SECRET?: string;
  /**
   * RevenueCat REST API（`GET /subscribers/{app_user_id}`）呼び出し用のSecret API Key。
   * Cloudflare Secretsのみで管理し、モバイルへは絶対に返さない。未設定の間は
   * `POST /me/entitlements/refresh`を503 BILLING_NOT_CONFIGUREDにする。
   */
  REVENUECAT_SECRET_API_KEY?: string;
  /**
   * RevenueCat Product ID → productType（'subscription' | 'lifetime'）の明示マップ用
   * （Mobile-G4 Hardening）。Product ID最終値が未確定の間は未設定のままでよく、その場合
   * 有効なpremium entitlementがあっても`productType`は'unknown'を返す（文字列部分一致による
   * 誤推測はしない）。premiumActiveの判定自体はこの値を使わず、常にentitlement premiumの
   * 有無で行う。
   */
  REVENUECAT_MONTHLY_PRODUCT_ID?: string;
  REVENUECAT_LIFETIME_PRODUCT_ID?: string;

  /**
   * 管理画面（Phase 7）関連。招待コード方式のサインアップに必須の共有シークレットと、
   * 管理者用JWT（モバイルの`JWT_SIGNING_KEY_*`とは完全に別系統）の署名鍵。
   * いずれか未設定の間は`/admin/auth/*`を503 AUTH_NOT_CONFIGUREDにする（fail-closed）。
   */
  ADMIN_INVITE_CODE?: string;
  ADMIN_JWT_SECRET?: string;
  /** 管理画面Webアプリ（Cloudflare Pages）のOriginをカンマ区切りで指定。`/admin/*`のCORS許可に使う。 */
  ADMIN_WEB_ORIGINS?: string;

  /** 商品画像（管理画面からのアップロード）保存用R2バケット（Phase 7）。 */
  LOTTERY_IMAGES?: R2Bucket;
}

export type Variables = {
  db: Db;
  env: Env;
  /** 全リクエストへ付与する追跡用ID（レスポンス・エラー・監査ログで共通利用、Mobile-G2A）。 */
  requestId: string;
  /** 認証ミドルウェア通過後にのみ設定される、DB内部の整数userId（Mobile-G2A）。 */
  userId?: number;
  /** 同上、外部公開用のpublicUserId（UUIDv4）。 */
  publicUserId?: string;
  /** `requireAuthConfigured`ミドルウェアが検証済みの認証設定（Mobile-G2A-Hardening）。 */
  authConfig?: AuthRuntimeConfig;
  /** `requireAdminAuthConfigured`ミドルウェアが検証済みの管理画面認証設定（Phase 7）。 */
  adminAuthConfig?: AdminAuthRuntimeConfig;
  /** `requireAdminAuth`ミドルウェア通過後にのみ設定される、管理者アカウントの整数id（Phase 7）。 */
  adminUserId?: number;
};

export type AppEnv = { Bindings: Env; Variables: Variables };
