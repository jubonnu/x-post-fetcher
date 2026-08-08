import { z } from "zod";

const PASSWORD_MIN_LENGTH = 8;

// メールアドレスは大文字小文字を区別しない運用にする（一般的なメール仕様上の慣習に合わせる）。
// 正規化せずDBの一意制約・検索に使うと、"Name@Example.com"で登録し"name@example.com"で
// ログインしようとした際に別アカウント扱い・ログイン不可になってしまうため、
// signup/loginの両方でtrim+小文字化した値のみをDBへ渡す。
const emailSchema = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .email()
  .transform((v) => v.toLowerCase());

export const adminSignupRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(PASSWORD_MIN_LENGTH).max(200),
  inviteCode: z.string().min(1),
});

export const adminLoginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export const adminChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(200),
});
