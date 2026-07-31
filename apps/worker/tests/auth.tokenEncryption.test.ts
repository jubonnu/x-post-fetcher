/**
 * Mobile-G2A-Hardening: Apple Refresh Token暗号化（AES-256-GCM）の往復・鍵ローテーション確認。
 */
import { describe, expect, it } from "vitest";
import {
  TokenEncryptionError,
  decodeEncryptionKeyBase64,
  decryptToken,
  encryptToken,
  type EncryptionKeySet,
} from "../src/auth/tokenEncryption.ts";

function randomBase64Key(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

describe("tokenEncryption", () => {
  it("暗号化→復号で元の平文が復元できる", async () => {
    const keys: EncryptionKeySet = { current: { version: "v1", keyBytes: decodeEncryptionKeyBase64(randomBase64Key(), "test") } };
    const plaintext = "apple-refresh-token-secret-value-abc123";

    const encrypted = await encryptToken(plaintext, keys);
    expect(encrypted.ciphertextBase64).not.toContain(plaintext);
    expect(encrypted.keyVersion).toBe("v1");

    const decrypted = await decryptToken(encrypted, keys);
    expect(decrypted).toBe(plaintext);
  });

  it("暗号化のたびに異なるIVが使われる（同じ平文でも暗号文が変わる）", async () => {
    const keys: EncryptionKeySet = { current: { version: "v1", keyBytes: decodeEncryptionKeyBase64(randomBase64Key(), "test") } };
    const plaintext = "same-plaintext-value";

    const a = await encryptToken(plaintext, keys);
    const b = await encryptToken(plaintext, keys);

    expect(a.ivBase64).not.toBe(b.ivBase64);
    expect(a.ciphertextBase64).not.toBe(b.ciphertextBase64);
  });

  it("鍵ローテーション: 旧鍵(previous)で暗号化した値を、current=新鍵/previous=旧鍵の設定で復号できる", async () => {
    const oldKeyBytes = decodeEncryptionKeyBase64(randomBase64Key(), "test");
    const newKeyBytes = decodeEncryptionKeyBase64(randomBase64Key(), "test");

    const oldKeys: EncryptionKeySet = { current: { version: "v1", keyBytes: oldKeyBytes } };
    const encryptedWithOldKey = await encryptToken("secret-before-rotation", oldKeys);

    const rotatedKeys: EncryptionKeySet = {
      current: { version: "v2", keyBytes: newKeyBytes },
      previous: { version: "v1", keyBytes: oldKeyBytes },
    };
    const decrypted = await decryptToken(encryptedWithOldKey, rotatedKeys);
    expect(decrypted).toBe("secret-before-rotation");
  });

  it("旧鍵が退役後（previous未設定）は旧世代の暗号文を復号できない", async () => {
    const oldKeyBytes = decodeEncryptionKeyBase64(randomBase64Key(), "test");
    const newKeyBytes = decodeEncryptionKeyBase64(randomBase64Key(), "test");

    const oldKeys: EncryptionKeySet = { current: { version: "v1", keyBytes: oldKeyBytes } };
    const encryptedWithOldKey = await encryptToken("secret-before-rotation", oldKeys);

    const newKeysOnly: EncryptionKeySet = { current: { version: "v2", keyBytes: newKeyBytes } };
    await expect(decryptToken(encryptedWithOldKey, newKeysOnly)).rejects.toThrow(TokenEncryptionError);
  });

  it("32byteでない鍵はエラーになる", () => {
    expect(() => decodeEncryptionKeyBase64(btoa("too-short"), "TEST_KEY")).toThrow(TokenEncryptionError);
  });

  it("改ざんされた暗号文は復号に失敗する（認証付き暗号のため）", async () => {
    const keys: EncryptionKeySet = { current: { version: "v1", keyBytes: decodeEncryptionKeyBase64(randomBase64Key(), "test") } };
    const encrypted = await encryptToken("original-secret", keys);
    const tampered = { ...encrypted, ciphertextBase64: encrypted.ciphertextBase64.slice(0, -4) + "AAAA" };

    await expect(decryptToken(tampered, keys)).rejects.toThrow(TokenEncryptionError);
  });
});
