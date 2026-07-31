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
});

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
  deviceId: z.string().min(1),
});

export const logoutRequestSchema = z.object({
  deviceId: z.string().min(1),
});
