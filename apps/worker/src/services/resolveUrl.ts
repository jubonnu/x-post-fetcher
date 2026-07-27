/**
 * URL リダイレクト追跡（SSRF 対策付き）。
 * - プライベート/ループバック/リンクローカル/予約済み IP をブロック
 * - 手動リダイレクト追跡（redirect: "manual"）、最大 5 ホップ
 * - 各ホップで DNS 解決して IP 検証
 * - URL に認証情報が含まれる場合は拒否
 */

export interface ResolveUrlResult {
  resolvedUrl: string | null;
  httpStatus: number | null;
  error: string | null;
  errorCode?: string;
}

const MAX_REDIRECTS = 5;
const MAX_URL_LENGTH = 2048;

/** IPv4 プライベートレンジチェック（a.b.c.d を 32bit 整数で評価）。 */
function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 127.0.0.0/8
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 (Carrier-Grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  // 224.0.0.0/4 (multicast)
  if (a >= 224 && a <= 239) return true;
  // 255.255.255.255
  if (nums.every((n) => n === 255)) return true;
  return false;
}

/** IPv6 プライベートアドレスチェック。 */
function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  // ::1 loopback
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  // fc00::/7 (unique local)
  if (/^f[cd]/i.test(lower)) return true;
  // fe80::/10 (link-local)
  if (/^fe[89ab]/i.test(lower)) return true;
  return false;
}

/** DNS 解決して IP がプライベートかどうか確認する（Node.js 環境用）。 */
async function checkDnsIp(hostname: string): Promise<string | null> {
  // Cloudflare Workers 環境では dns モジュールが使えないため、
  // ここでは IPv4/IPv6 リテラル文字列のみ直接チェックし、
  // DNS 名はランタイム側で解決済みとして信頼する（Workers の fetch はサンドボックス済み）。
  // テスト・Node.js 環境では dns/promises を動的 import して確認する。
  try {
    const dns = await import("node:dns/promises");
    const results = await dns.lookup(hostname, { all: true });
    for (const r of results) {
      if (r.family === 4 && isPrivateIPv4(r.address)) return r.address;
      if (r.family === 6 && isPrivateIPv6(r.address)) return r.address;
    }
  } catch {
    // DNS 解決失敗 or Workers 環境（モジュール未存在）→ スキップ
  }
  return null;
}

/**
 * URL のスキーム・認証情報・IP リテラルを検証する。
 * 問題があれば errorCode を返す。
 */
async function validateUrl(urlStr: string): Promise<{ ok: true } | { ok: false; errorCode: string }> {
  if (urlStr.length > MAX_URL_LENGTH) return { ok: false, errorCode: "url_too_long" };

  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return { ok: false, errorCode: "invalid_url" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, errorCode: "invalid_scheme" };
  }

  // 認証情報が含まれている場合は拒否
  if (url.username || url.password) {
    return { ok: false, errorCode: "credentials_in_url" };
  }

  const hostname = url.hostname;

  // IP リテラルを直接チェック
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isPrivateIPv4(hostname)) return { ok: false, errorCode: "private_address" };
  } else if (hostname.startsWith("[") || /^[0-9a-f:]+$/i.test(hostname)) {
    if (isPrivateIPv6(hostname)) return { ok: false, errorCode: "private_address" };
  } else {
    // DNS 解決して IP 確認
    const privateIp = await checkDnsIp(hostname);
    if (privateIp !== null) {
      if (privateIp === "127.0.0.1" || privateIp.startsWith("127.") || privateIp === "::1") {
        return { ok: false, errorCode: "loopback_address" };
      }
      if ((privateIp.startsWith("169.254.") )) {
        return { ok: false, errorCode: "link_local_address" };
      }
      return { ok: false, errorCode: "private_address" };
    }
  }

  return { ok: true };
}

export async function resolveUrl(originalUrl: string, timeoutMs = 10_000): Promise<ResolveUrlResult> {
  const validation = await validateUrl(originalUrl);
  if (!validation.ok) {
    return { resolvedUrl: null, httpStatus: null, error: validation.errorCode, errorCode: validation.errorCode };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let currentUrl = originalUrl;
  let lastStatus: number | null = null;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (hop === MAX_REDIRECTS + 1) {
        return { resolvedUrl: null, httpStatus: null, error: "too_many_redirects", errorCode: "too_many_redirects" };
      }

      let res: Response;
      try {
        res = await fetch(currentUrl, {
          method: hop === 0 ? "HEAD" : "HEAD",
          redirect: "manual",
          signal: controller.signal,
          headers: { "User-Agent": "x-post-fetcher/1.0 (URL resolver)" },
        });
      } catch (e) {
        if (controller.signal.aborted) {
          return { resolvedUrl: null, httpStatus: null, error: "timeout", errorCode: "timeout" };
        }
        return { resolvedUrl: null, httpStatus: null, error: String(e) };
      }

      lastStatus = res.status;

      // HEAD が 405 なら GET で再試行（リダイレクト 0 ホップ目のみ）
      if (res.status === 405 && hop === 0) {
        try {
          res = await fetch(currentUrl, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: { "User-Agent": "x-post-fetcher/1.0 (URL resolver)" },
          });
          lastStatus = res.status;
        } catch (e) {
          if (controller.signal.aborted) {
            return { resolvedUrl: null, httpStatus: null, error: "timeout", errorCode: "timeout" };
          }
          return { resolvedUrl: null, httpStatus: null, error: String(e) };
        }
      }

      // リダイレクトでなければ解決完了
      if (res.status < 300 || res.status >= 400) {
        return { resolvedUrl: currentUrl, httpStatus: res.status, error: null };
      }

      // Location ヘッダを追跡
      const location = res.headers.get("location");
      if (!location) {
        return { resolvedUrl: currentUrl, httpStatus: res.status, error: null };
      }

      // 相対 URL を絶対 URL に解決
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        return { resolvedUrl: null, httpStatus: null, error: "invalid_redirect", errorCode: "invalid_redirect" };
      }

      // リダイレクト先の URL を検証（SSRF チェック）
      const nextValidation = await validateUrl(nextUrl);
      if (!nextValidation.ok) {
        return {
          resolvedUrl: null,
          httpStatus: null,
          error: nextValidation.errorCode,
          errorCode: nextValidation.errorCode,
        };
      }

      if (hop === MAX_REDIRECTS) {
        return { resolvedUrl: null, httpStatus: null, error: "too_many_redirects", errorCode: "too_many_redirects" };
      }

      currentUrl = nextUrl;
    }

    // ここには到達しない
    return { resolvedUrl: currentUrl, httpStatus: lastStatus, error: null };
  } finally {
    clearTimeout(timer);
  }
}
