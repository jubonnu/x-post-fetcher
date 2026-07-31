/**
 * Sign in with Apple identityToken検証（Mobile-G2A）。
 * Apple本物のJWKSエンドポイントには依存せず、テスト用に生成したRSA鍵ペアと
 * 差し替え可能な鍵解決関数（__setAppleJwksResolverForTests）で検証ロジックのみを対象にする。
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AppleIdentityTokenError,
  __setAppleJwksResolverForTests,
  verifyAppleIdentityToken,
} from "../src/auth/apple.ts";
import {
  TEST_APPLE_CLIENT_ID,
  TEST_APPLE_SUB,
  createAppleTestKeyPair,
  makeAppleJwksResolver,
  makeFailingJwksResolver,
  signTestAppleToken,
  tamperSignature,
} from "./helpers/appleTestKit.ts";
import type { KeyLike } from "jose";

let privateKey: KeyLike;
let publicKey: KeyLike;

beforeAll(async () => {
  const pair = await createAppleTestKeyPair();
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
});

afterEach(() => {
  __setAppleJwksResolverForTests(undefined);
});

describe("verifyAppleIdentityToken", () => {
  it("正常なidentityTokenを検証できる", async () => {
    __setAppleJwksResolverForTests(makeAppleJwksResolver(publicKey));
    const token = await signTestAppleToken({ privateKey, email: "user@example.com", emailVerified: true });

    const claims = await verifyAppleIdentityToken({ identityToken: token, appleClientId: TEST_APPLE_CLIENT_ID });

    expect(claims.sub).toBe(TEST_APPLE_SUB);
    expect(claims.email).toBe("user@example.com");
    expect(claims.emailVerified).toBe(true);
  });

  it("不正署名（改ざん）を拒否する", async () => {
    __setAppleJwksResolverForTests(makeAppleJwksResolver(publicKey));
    const token = tamperSignature(await signTestAppleToken({ privateKey }));

    await expect(
      verifyAppleIdentityToken({ identityToken: token, appleClientId: TEST_APPLE_CLIENT_ID })
    ).rejects.toThrow(AppleIdentityTokenError);
  });

  it("不正issuerを拒否する", async () => {
    __setAppleJwksResolverForTests(makeAppleJwksResolver(publicKey));
    const token = await signTestAppleToken({ privateKey, iss: "https://evil.example.com" });

    await expect(
      verifyAppleIdentityToken({ identityToken: token, appleClientId: TEST_APPLE_CLIENT_ID })
    ).rejects.toThrow(AppleIdentityTokenError);
  });

  it("不正audienceを拒否する", async () => {
    __setAppleJwksResolverForTests(makeAppleJwksResolver(publicKey));
    const token = await signTestAppleToken({ privateKey, aud: "com.someone-else.app" });

    await expect(
      verifyAppleIdentityToken({ identityToken: token, appleClientId: TEST_APPLE_CLIENT_ID })
    ).rejects.toThrow(AppleIdentityTokenError);
  });

  it("期限切れトークンを拒否する", async () => {
    __setAppleJwksResolverForTests(makeAppleJwksResolver(publicKey));
    const token = await signTestAppleToken({ privateKey, issuedAtOffsetSeconds: -1200, expiresInSeconds: 600 });

    await expect(
      verifyAppleIdentityToken({ identityToken: token, appleClientId: TEST_APPLE_CLIENT_ID })
    ).rejects.toThrow(AppleIdentityTokenError);
  });

  it("nonce不一致を拒否する", async () => {
    __setAppleJwksResolverForTests(makeAppleJwksResolver(publicKey));
    const token = await signTestAppleToken({ privateKey, nonce: "hash-of-a-different-nonce" });

    await expect(
      verifyAppleIdentityToken({ identityToken: token, appleClientId: TEST_APPLE_CLIENT_ID, rawNonce: "the-real-raw-nonce" })
    ).rejects.toThrow(AppleIdentityTokenError);
  });

  it("kid不明を拒否する", async () => {
    __setAppleJwksResolverForTests(makeAppleJwksResolver(publicKey, "known-kid"));
    const token = await signTestAppleToken({ privateKey, kid: "totally-different-kid" });

    await expect(
      verifyAppleIdentityToken({ identityToken: token, appleClientId: TEST_APPLE_CLIENT_ID })
    ).rejects.toThrow(AppleIdentityTokenError);
  });

  it("JWKS取得失敗を拒否する", async () => {
    __setAppleJwksResolverForTests(makeFailingJwksResolver());
    const token = await signTestAppleToken({ privateKey });

    await expect(
      verifyAppleIdentityToken({ identityToken: token, appleClientId: TEST_APPLE_CLIENT_ID })
    ).rejects.toThrow(AppleIdentityTokenError);
  });

  it("iatが無いトークンを拒否する", async () => {
    __setAppleJwksResolverForTests(makeAppleJwksResolver(publicKey));
    const token = await signTestAppleToken({ privateKey, omitIat: true });

    await expect(
      verifyAppleIdentityToken({ identityToken: token, appleClientId: TEST_APPLE_CLIENT_ID })
    ).rejects.toThrow(AppleIdentityTokenError);
  });
});
