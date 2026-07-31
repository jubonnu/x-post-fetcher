/**
 * Apple Refresh Token等の機密トークンをDBへ保存する前に暗号化するためのモジュール。
 * AES-256-GCM（Web Crypto、Workers/Node共通、追加ライブラリ不要）を使用する。
 * IV（12byte、AES-GCMの推奨長）は暗号化のたびに乱数生成し、暗号文と共に保存する
 * （IVは秘密情報ではない。GCMの安全性は同一鍵でのIV再利用を避けることに依存するため、
 * 呼び出しごとに新しいIVを生成することが重要）。
 * `keyVersion`を暗号文と一緒に保存することで、暗号鍵をローテーションしても
 * 過去の暗号文を復号可能にする（現行鍵での復号に失敗した場合に備え、直前世代の鍵も試す）。
 */
export class TokenEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenEncryptionError";
  }
}

export interface EncryptionKey {
  version: string;
  keyBytes: Uint8Array;
}

export interface EncryptionKeySet {
  current: EncryptionKey;
  /** ローテーション期間中のみ設定する、復号にのみ使う直前世代の鍵。 */
  previous?: EncryptionKey;
}

export interface EncryptedPayload {
  ciphertextBase64: string;
  ivBase64: string;
  keyVersion: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importAesGcmKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Base64エンコードされた鍵文字列（32byte/AES-256相当）をデコードする。長さも検証する。 */
export function decodeEncryptionKeyBase64(base64Key: string, fieldName: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(base64Key);
  } catch {
    throw new TokenEncryptionError(`${fieldName} のBase64デコードに失敗しました`);
  }
  if (bytes.length !== 32) {
    throw new TokenEncryptionError(`${fieldName} は32byte（AES-256用）である必要があります`);
  }
  return bytes;
}

export async function encryptToken(plaintext: string, keys: EncryptionKeySet): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesGcmKey(keys.current.keyBytes);
  const data = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, data);

  return {
    ciphertextBase64: toBase64(new Uint8Array(ciphertext)),
    ivBase64: toBase64(iv),
    keyVersion: keys.current.version,
  };
}

export async function decryptToken(payload: EncryptedPayload, keys: EncryptionKeySet): Promise<string> {
  const matchedKey =
    payload.keyVersion === keys.current.version
      ? keys.current
      : payload.keyVersion === keys.previous?.version
        ? keys.previous
        : undefined;

  if (!matchedKey) {
    throw new TokenEncryptionError(`未知の暗号鍵世代です: ${payload.keyVersion}`);
  }

  const key = await importAesGcmKey(matchedKey.keyBytes);
  const iv = fromBase64(payload.ivBase64);
  const ciphertext = fromBase64(payload.ciphertextBase64);

  try {
    const plaintextBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ciphertext as BufferSource);
    return new TextDecoder().decode(plaintextBuf);
  } catch {
    throw new TokenEncryptionError("復号に失敗しました（鍵不一致またはデータ破損の可能性）");
  }
}
