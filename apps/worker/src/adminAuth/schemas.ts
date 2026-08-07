import { z } from "zod";

const PASSWORD_MIN_LENGTH = 8;

export const adminSignupRequestSchema = z.object({
  email: z.string().trim().min(1).max(320).email(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(200),
  inviteCode: z.string().min(1),
});

export const adminLoginRequestSchema = z.object({
  email: z.string().trim().min(1).max(320).email(),
  password: z.string().min(1).max(200),
});

export const adminChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(200),
});
