import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/adminAuth/password.ts";

describe("hashPassword / verifyPassword", () => {
  it("正しいパスワードはverifyPasswordがtrueを返す", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(true);
  });

  it("間違ったパスワードはfalseを返す", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("同じパスワードでも毎回異なるsalt・ハッシュ文字列になる（レインボーテーブル対策）", async () => {
    const hashA = await hashPassword("same-password-123");
    const hashB = await hashPassword("same-password-123");
    expect(hashA).not.toBe(hashB);
    expect(await verifyPassword("same-password-123", hashA)).toBe(true);
    expect(await verifyPassword("same-password-123", hashB)).toBe(true);
  });

  it("日本語・記号を含むパスワードでも正しく検証できる", async () => {
    const password = "パスワード!@#$%^&*()_+日本語123";
    const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
  });

  it("不正な形式のハッシュ文字列はfalseを返す（例外を投げない）", async () => {
    expect(await verifyPassword("anything", "not-a-valid-hash")).toBe(false);
    expect(await verifyPassword("anything", "pbkdf2$notanumber$salt$hash")).toBe(false);
  });
});
