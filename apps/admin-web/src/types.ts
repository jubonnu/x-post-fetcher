/** x-post-fetcher `apps/worker` の `/admin/*` APIレスポンス形状（手動で同期、契約テストは無い）。 */

export interface AdminUser {
  id: number;
  email: string;
  createdAt: string;
}

export interface LotteryRow {
  id: number;
  /** 元投稿（source_posts）のID。スクレイピング由来でなければnull（Phase 9）。 */
  sourcePostId: number | null;
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

/** `lottery_update_candidates`の1行（Phase 11）。`extractedData`はJSON文字列のまま保持する。 */
export interface LotteryUpdateCandidateRow {
  id: number;
  targetLotteryId: number;
  sourcePostId: number;
  candidateIndex: number;
  candidateKey: string;
  matchScore: string | null;
  matchReason: string | null;
  extractedData: string;
  status: "pending" | "applied" | "registered_as_new" | "ignored";
  resolvedBy: string | null;
  resolvedAt: string | null;
  appliedFields: string | null;
  registeredLotteryId: number | null;
  createdAt: string;
  updatedAt: string;
  /** 元投稿がXに投稿された日時（管理者が実際のX投稿と突き合わせて確認できるようにするため）。 */
  sourcePostPublishedAt: string | null;
}

export interface LotteryUpdateCandidateListResponse {
  items: LotteryUpdateCandidateRow[];
  total: number;
}

/** 抽出済みデータ（`toLotteryRow`と同形）。差分表示用に必要なフィールドのみ宣言する。 */
export interface ExtractedLotteryData {
  productNameRaw: string | null;
  normalizedProductName: string | null;
  storeNameRaw: string | null;
  normalizedStoreName: string | null;
  storeBranchRaw: string | null;
  region: string | null;
  applicationStartAt: string | null;
  applicationEndAt: string | null;
  applicationEndDate: string | null;
  resultAnnouncementStartAt: string | null;
  resultAnnouncementAt: string | null;
  resultAnnouncementDate: string | null;
  purchaseStartAt: string | null;
  purchaseDeadlineAt: string | null;
  applicationUrl: string | null;
  applicationMethod: string | null;
  [key: string]: unknown;
}

export interface FieldChange {
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  changeType: "updated" | "conflicting";
}

export interface SourcePostSummary {
  id: number;
  externalPostId: string;
  sourceUrl: string | null;
  bodyRaw: string | null;
  publishedAt: string | null;
}

export interface LotteryUpdateCandidateDetailResponse {
  candidate: LotteryUpdateCandidateRow;
  targetLottery: LotteryRow | null;
  extractedData: ExtractedLotteryData;
  addableFields: FieldChange[];
  overwritableFields: FieldChange[];
  conflictingFields: FieldChange[];
  matchingFields: string[];
  newSourcePost: SourcePostSummary | null;
  existingSourcePost: SourcePostSummary | null;
}
