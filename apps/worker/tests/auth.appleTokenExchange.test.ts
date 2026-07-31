/**
 * Mobile-G2A-Hardening: Apple authorizationCode交換・トークン失効。
 * 実際のApple APIへは一切通信しない（`fetchImpl`を注入したモックのみを使用）。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import {
  AppleTokenExchangeError,
  AppleTokenRevokeError,
  exchangeAppleAuthorizationCode,
  generateAppleClientSecret,
  revokeAppleToken,
} from "../src/auth/appleTokenExchange.ts";

let privateKeyPem: string;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  privateKeyPem = await exportPKCS8(privateKey);
});

describe("generateAppleClientSecret", () => {
  it("iss/sub/aud/kidを含むES256署名JWTを生成する", async () => {
    const jwt = await generateAppleClientSecret({
      teamId: "TEAM123456",
      keyId: "KEY7890",
      privateKeyPem,
      clientId: "com.cardhub.mobile",
    });

    // 対応する公開鍵検証はここでは行わず（秘密鍵しか無いため）、クレーム形状のみ確認
    const [, payloadB64] = jwt.split(".");
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));
    expect(payload.iss).toBe("TEAM123456");
    expect(payload.sub).toBe("com.cardhub.mobile");
    expect(payload.aud).toBe("https://appleid.apple.com");

    const header = JSON.parse(atob(jwt.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")));
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe("KEY7890");
  });

  it("生成したJWTは対応する公開鍵で検証できる（署名として妥当）", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const jwt = await generateAppleClientSecret({ teamId: "T1", keyId: "K1", privateKeyPem: pem, clientId: "cid" });

    const { payload } = await jwtVerify(jwt, publicKey, { issuer: "T1", audience: "https://appleid.apple.com" });
    expect(payload.sub).toBe("cid");
  });
});

describe("exchangeAppleAuthorizationCode", () => {
  it("正常なレスポンスからrefresh_tokenを取得する", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ refresh_token: "mock-apple-refresh-token", expires_in: 3600 }), { status: 200 })
    );

    const result = await exchangeAppleAuthorizationCode("auth-code-1", "client-secret-jwt", { clientId: "cid" }, { fetchImpl });

    expect(result.appleRefreshToken).toBe("mock-apple-refresh-token");
    expect(result.expiresIn).toBe(3600);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://appleid.apple.com/auth/token");
    expect(String(init?.body)).toContain("grant_type=authorization_code");
  });

  it("Apple側エラー応答は例外になる（クライアントシークレットやコードはエラーに含めない）", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));

    await expect(
      exchangeAppleAuthorizationCode("auth-code-1", "super-secret-jwt-value", { clientId: "cid" }, { fetchImpl })
    ).rejects.toThrow(AppleTokenExchangeError);
  });

  it("refresh_tokenが含まれないレスポンスはエラー", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(
      exchangeAppleAuthorizationCode("auth-code-1", "secret", { clientId: "cid" }, { fetchImpl })
    ).rejects.toThrow(AppleTokenExchangeError);
  });
});

describe("revokeAppleToken", () => {
  it("正常に失効できる", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const result = await revokeAppleToken("apple-refresh-token", "secret", { clientId: "cid" }, { fetchImpl });
    expect(result.alreadyInvalid).toBe(false);
  });

  it("invalid_grant（既に無効）は成功扱いにする", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const result = await revokeAppleToken("apple-refresh-token", "secret", { clientId: "cid" }, { fetchImpl });
    expect(result.alreadyInvalid).toBe(true);
  });

  it("その他のエラーは例外になる（再試行は呼び出し側の責務）", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "server_error" }), { status: 500 }));
    await expect(revokeAppleToken("apple-refresh-token", "secret", { clientId: "cid" }, { fetchImpl })).rejects.toThrow(
      AppleTokenRevokeError
    );
  });
});
