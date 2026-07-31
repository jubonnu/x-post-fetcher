/**
 * Mobile-G2A-Hardening: Apple token交換設定の解決（未設定時は例外を投げずundefinedにする）。
 */
import { describe, expect, it } from "vitest";
import { resolveAppleTokenExchangeConfig } from "../src/auth/appleTokenExchangeConfig.ts";
import type { Env } from "../src/env.ts";

function randomBase64Key(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const baseEnv: Env = { ENVIRONMENT: "test" };

describe("resolveAppleTokenExchangeConfig", () => {
  it("4つの必須値が1つでも欠けていればundefinedを返す（例外にしない）", () => {
    expect(resolveAppleTokenExchangeConfig(baseEnv, "cid")).toBeUndefined();
    expect(
      resolveAppleTokenExchangeConfig(
        { ...baseEnv, APPLE_TEAM_ID: "T1", APPLE_KEY_ID: "K1", APPLE_PRIVATE_KEY: "pem" },
        "cid"
      )
    ).toBeUndefined();
  });

  it("4つ揃っていれば設定を返す", () => {
    const env: Env = {
      ...baseEnv,
      APPLE_TEAM_ID: "T1",
      APPLE_KEY_ID: "K1",
      APPLE_PRIVATE_KEY: "pem-content",
      APPLE_TOKEN_ENCRYPTION_KEY: randomBase64Key(),
    };
    const config = resolveAppleTokenExchangeConfig(env, "cid");
    expect(config).toBeDefined();
    expect(config?.clientSecretConfig.teamId).toBe("T1");
    expect(config?.encryptionKeys.current.version).toBe("v1");
  });

  it("暗号鍵の形式が不正ならundefinedを返す（例外にしない）", () => {
    const env: Env = {
      ...baseEnv,
      APPLE_TEAM_ID: "T1",
      APPLE_KEY_ID: "K1",
      APPLE_PRIVATE_KEY: "pem-content",
      APPLE_TOKEN_ENCRYPTION_KEY: "not-valid-base64-32byte-key",
    };
    expect(resolveAppleTokenExchangeConfig(env, "cid")).toBeUndefined();
  });

  it("直前世代の暗号鍵が設定されていればpreviousとして解決する", () => {
    const env: Env = {
      ...baseEnv,
      APPLE_TEAM_ID: "T1",
      APPLE_KEY_ID: "K1",
      APPLE_PRIVATE_KEY: "pem-content",
      APPLE_TOKEN_ENCRYPTION_KEY: randomBase64Key(),
      APPLE_TOKEN_ENCRYPTION_KEY_VERSION: "v2",
      APPLE_TOKEN_ENCRYPTION_KEY_PREVIOUS: randomBase64Key(),
      APPLE_TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION: "v1",
    };
    const config = resolveAppleTokenExchangeConfig(env, "cid");
    expect(config?.encryptionKeys.current.version).toBe("v2");
    expect(config?.encryptionKeys.previous?.version).toBe("v1");
  });
});
