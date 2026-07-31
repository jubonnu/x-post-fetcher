/**
 * Access Token(JWT)の発行・検証・kidローテーション（Mobile-G2A）。
 */
import { describe, expect, it } from "vitest";
import { AccessTokenError, signAccessToken, verifyAccessToken } from "../src/auth/accessToken.ts";
import type { JwtSigningKeys } from "../src/auth/config.ts";

const KEYS_V1: JwtSigningKeys = { current: { kid: "v1", secret: "secret-v1-not-for-production" } };
const KEYS_V2_WITH_PREVIOUS: JwtSigningKeys = {
  current: { kid: "v2", secret: "secret-v2-not-for-production" },
  previous: { kid: "v1", secret: "secret-v1-not-for-production" },
};
const KEYS_V2_ONLY: JwtSigningKeys = { current: { kid: "v2", secret: "secret-v2-not-for-production" } };

describe("Access Token", () => {
  it("発行したトークンを同じ鍵で検証できる", async () => {
    const token = await signAccessToken({ publicUserId: "user-public-id-1", signingKeys: KEYS_V1 });
    const claims = await verifyAccessToken(token, KEYS_V1);
    expect(claims.publicUserId).toBe("user-public-id-1");
    expect(claims.jti).toEqual(expect.any(String));
  });

  it("ローテーション中、旧鍵(v1)で発行したトークンをcurrent=v2/previous=v1の設定で検証できる", async () => {
    const token = await signAccessToken({ publicUserId: "user-public-id-1", signingKeys: KEYS_V1 });
    const claims = await verifyAccessToken(token, KEYS_V2_WITH_PREVIOUS);
    expect(claims.publicUserId).toBe("user-public-id-1");
  });

  it("旧鍵が退役後（previous未設定）は旧kidのトークンを拒否する", async () => {
    const token = await signAccessToken({ publicUserId: "user-public-id-1", signingKeys: KEYS_V1 });
    await expect(verifyAccessToken(token, KEYS_V2_ONLY)).rejects.toThrow(AccessTokenError);
  });

  it("新規発行は常に現行鍵(current)を使う", async () => {
    const token = await signAccessToken({ publicUserId: "user-public-id-1", signingKeys: KEYS_V2_WITH_PREVIOUS });
    // v1のみの設定では検証できない（=current鍵で署名されている証拠）
    await expect(verifyAccessToken(token, KEYS_V1)).rejects.toThrow(AccessTokenError);
    const claims = await verifyAccessToken(token, KEYS_V2_WITH_PREVIOUS);
    expect(claims.publicUserId).toBe("user-public-id-1");
  });

  it("期限切れトークンを拒否する", async () => {
    const token = await signAccessToken({ publicUserId: "user-public-id-1", signingKeys: KEYS_V1, ttlSeconds: -1 });
    await expect(verifyAccessToken(token, KEYS_V1)).rejects.toThrow(AccessTokenError);
  });

  it("不正な署名を拒否する", async () => {
    const token = await signAccessToken({ publicUserId: "user-public-id-1", signingKeys: KEYS_V1 });
    const tampered = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
    await expect(verifyAccessToken(tampered, KEYS_V1)).rejects.toThrow(AccessTokenError);
  });
});
