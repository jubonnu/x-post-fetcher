import { z } from "zod";

export const appleAuthRequestSchema = z.object({
  identityToken: z.string().min(1),
  /**
   * Appleの認可コード。将来のApple側トークン失効実装のために受け取るが、
   * Mobile-G2Aでは交換処理（Apple秘密鍵によるclient_secret生成）を実装しないため、
   * このフィールドは現時点では保存・使用しない（詳細は完了報告 11章）。
   */
  authorizationCode: z.string().optional(),
  /** クライアントが認可リクエスト時に使用した生のnonce（渡された場合のみnonce検証を行う）。 */
  rawNonce: z.string().optional(),
  deviceId: z.string().min(1),
  deviceName: z.string().optional(),
  /**
   * Appleが初回認可時にのみ返すfullName（Mobile-G4 Hardening）。クライアント側で
   * 表示用に組み立てた文字列をそのまま受け取り、`users.displayName`が未設定の場合のみ
   * 保存する（`routes/auth.ts`側で判定。既存のdisplayNameを上書きしない）。
   */
  fullName: z.string().min(1).max(200).optional(),
});

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
  deviceId: z.string().min(1),
});

export const logoutRequestSchema = z.object({
  deviceId: z.string().min(1),
});
