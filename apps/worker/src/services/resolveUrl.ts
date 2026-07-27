/**
 * URL リダイレクト追跡（Phase 4）。
 * t.co 等の短縮URLを HTTP fetch で最終URLに解決する。ブラウザは使用しない。
 * HEAD 405 の場合は GET にフォールバックする。
 */

export interface ResolveUrlResult {
  resolvedUrl: string | null;
  httpStatus: number | null;
  error: string | null;
}

export async function resolveUrl(originalUrl: string, timeoutMs = 10_000): Promise<ResolveUrlResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res = await fetch(originalUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    if (res.status === 405) {
      res = await fetch(originalUrl, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
      });
    }
    return { resolvedUrl: res.url || originalUrl, httpStatus: res.status, error: null };
  } catch (e) {
    if (controller.signal.aborted) {
      return { resolvedUrl: null, httpStatus: null, error: "timeout" };
    }
    return { resolvedUrl: null, httpStatus: null, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}
