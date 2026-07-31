/**
 * Mobile-G2A-Hardening: 認証設定のfail-closed検証（resolveAuthRuntimeConfig）。
 */
import { describe, expect, it } from "vitest";
import { AuthConfigError, resolveAuthRuntimeConfig } from "../src/auth/config.ts";
import type { Env } from "../src/env.ts";

function baseValidEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "test",
    APPLE_CLIENT_ID: "com.cardhub.mobile.testkit",
    JWT_SIGNING_KEY_CURRENT_KID: "test-v1",
    JWT_SIGNING_KEY_CURRENT_SECRET: "unit-test-secret-value-1234567890",
    ...overrides,
  };
}

describe("resolveAuthRuntimeConfig", () => {
  it("ENVIRONMENT未設定はエラー", () => {
    const env = baseValidEnv({ ENVIRONMENT: undefined });
    expect(() => resolveAuthRuntimeConfig(env)).toThrow(AuthConfigError);
  });

  it("不正なENVIRONMENT値はエラー", () => {
    const env = baseValidEnv({ ENVIRONMENT: "staging" });
    expect(() => resolveAuthRuntimeConfig(env)).toThrow(AuthConfigError);
  });

  it("productionでAPPLE_CLIENT_ID未設定はエラー", () => {
    const env = baseValidEnv({
      ENVIRONMENT: "production",
      APPLE_CLIENT_ID: undefined,
      ACCOUNT_DELETION_GRACE_DAYS: "14",
    });
    expect(() => resolveAuthRuntimeConfig(env)).toThrow(AuthConfigError);
  });

  it("productionでJWT署名鍵(secret)未設定はエラー", () => {
    const env = baseValidEnv({
      ENVIRONMENT: "production",
      APPLE_CLIENT_ID: "com.cardhub.mobile",
      JWT_SIGNING_KEY_CURRENT_SECRET: undefined,
      ACCOUNT_DELETION_GRACE_DAYS: "14",
    });
    expect(() => resolveAuthRuntimeConfig(env)).toThrow(AuthConfigError);
  });

  it("productionでプレースホルダー値（APPLE_CLIENT_ID）はエラー", () => {
    const env = baseValidEnv({
      ENVIRONMENT: "production",
      APPLE_CLIENT_ID: "com.example.placeholder",
      ACCOUNT_DELETION_GRACE_DAYS: "14",
    });
    expect(() => resolveAuthRuntimeConfig(env)).toThrow(AuthConfigError);
  });

  it("productionでプレースホルダー値（JWT secret: change-me）はエラー", () => {
    const env = baseValidEnv({
      ENVIRONMENT: "production",
      APPLE_CLIENT_ID: "com.cardhub.mobile",
      JWT_SIGNING_KEY_CURRENT_SECRET: "change-me-in-production",
      ACCOUNT_DELETION_GRACE_DAYS: "14",
    });
    expect(() => resolveAuthRuntimeConfig(env)).toThrow(AuthConfigError);
  });

  it("productionで空文字のAPPLE_CLIENT_IDはエラー", () => {
    const env = baseValidEnv({
      ENVIRONMENT: "production",
      APPLE_CLIENT_ID: "   ",
      ACCOUNT_DELETION_GRACE_DAYS: "14",
    });
    expect(() => resolveAuthRuntimeConfig(env)).toThrow(AuthConfigError);
  });

  it("productionでACCOUNT_DELETION_GRACE_DAYS未設定はエラー", () => {
    const env = baseValidEnv({ ENVIRONMENT: "production", APPLE_CLIENT_ID: "com.cardhub.mobile" });
    expect(() => resolveAuthRuntimeConfig(env)).toThrow(AuthConfigError);
  });

  it("productionで全て正当な値なら成功する", () => {
    const env = baseValidEnv({
      ENVIRONMENT: "production",
      APPLE_CLIENT_ID: "com.cardhub.mobile",
      JWT_SIGNING_KEY_CURRENT_SECRET: "a-real-random-looking-secret-value-999",
      ACCOUNT_DELETION_GRACE_DAYS: "14",
    });
    const config = resolveAuthRuntimeConfig(env);
    expect(config.environment).toBe("production");
    expect(config.accountDeletionGraceDays).toBe(14);
  });

  it("developmentで明示設定があれば成功する（暗黙のプレースホルダー生成はしない）", () => {
    const env = baseValidEnv({ ENVIRONMENT: "development" });
    const config = resolveAuthRuntimeConfig(env);
    expect(config.appleClientId).toBe(env.APPLE_CLIENT_ID);
    expect(config.accountDeletionGraceDays).toBe(14); // production以外の既定値
  });

  it("developmentでも必須値が無ければエラー（暗黙フォールバックしない）", () => {
    const env = baseValidEnv({ ENVIRONMENT: "development", APPLE_CLIENT_ID: undefined });
    expect(() => resolveAuthRuntimeConfig(env)).toThrow(AuthConfigError);
  });

  it("testでテスト依存注入（明示的なENVIRONMENT=testと値）があれば成功する", () => {
    const env = baseValidEnv({ ENVIRONMENT: "test" });
    const config = resolveAuthRuntimeConfig(env);
    expect(config.environment).toBe("test");
  });

  it("development/testではプレースホルダーらしき値でも通る（拒否は本番のみ）", () => {
    const env = baseValidEnv({ ENVIRONMENT: "development", APPLE_CLIENT_ID: "example.placeholder" });
    expect(() => resolveAuthRuntimeConfig(env)).not.toThrow();
  });

  it("プレースホルダー拒否時のエラーメッセージに実際の値を含めない", () => {
    const suspiciousSecret = "my-secret-change-me-should-not-appear-in-error-abc123";
    const env = baseValidEnv({
      ENVIRONMENT: "production",
      APPLE_CLIENT_ID: "com.cardhub.mobile",
      JWT_SIGNING_KEY_CURRENT_SECRET: suspiciousSecret,
      ACCOUNT_DELETION_GRACE_DAYS: "14",
    });
    try {
      resolveAuthRuntimeConfig(env);
      throw new Error("プレースホルダーとして拒否されるはずが成功した");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).not.toContain(suspiciousSecret);
      expect(message).toContain("JWT_SIGNING_KEY_CURRENT_SECRET");
    }
  });

  it("未設定エラーのメッセージにも値そのものは含まれない（そもそも値が無い）", () => {
    const env = baseValidEnv({ ENVIRONMENT: "production", APPLE_CLIENT_ID: undefined, ACCOUNT_DELETION_GRACE_DAYS: "14" });
    try {
      resolveAuthRuntimeConfig(env);
      throw new Error("エラーになるはずが成功した");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toContain("APPLE_CLIENT_ID");
    }
  });
});
