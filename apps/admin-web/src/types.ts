/** x-post-fetcher `apps/worker` の `/admin/*` APIレスポンス形状（手動で同期、契約テストは無い）。 */

export interface AdminUser {
  id: number;
  email: string;
  createdAt: string;
}

export interface LotteryRow {
  id: number;
  productNameRaw: string | null;
  normalizedProductName: string | null;
  storeNameRaw: string | null;
  normalizedStoreName: string | null;
  /** 応募開始日時（「A〜B」範囲表記の開始側。Phase 10）。 */
  applicationStartAt?: string | null;
  applicationEndAt: string | null;
  applicationEndDate: string | null;
  /** 当選発表開始日時（「A〜B」範囲表記の開始側。Phase 10）。 */
  resultAnnouncementStartAt?: string | null;
  resultAnnouncementAt: string | null;
  resultAnnouncementDate: string | null;
  /** 購入開始日時（「A〜B」範囲表記の開始側。Phase 10）。 */
  purchaseStartAt?: string | null;
  purchaseDeadlineAt: string | null;
  applicationUrl: string | null;
  /** 応募ページURLの複数指定（Phase 9）。1件目はapplicationUrlと同じ値。 */
  applicationUrls?: string[] | null;
  resolvedApplicationUrl: string | null;
  applicationMethod: string | null;
  imageUrl: string | null;
  verificationStatus: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  rejectedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** 元投稿がXに投稿された日時（一覧APIのみ返す。詳細APIでは undefined）。Phase 8。 */
  sourcePostPublishedAt?: string | null;
}

export interface LotteryListResponse {
  items: LotteryRow[];
  total: number;
}

export interface LotteryDetailResponse {
  lottery: LotteryRow;
  sources: unknown[];
  fieldHistory: unknown[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; requestId: string };
}
