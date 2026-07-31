import type { Context } from "hono";

/**
 * クライアントIPを取得する。Cloudflare Workers本番では `CF-Connecting-IP` が
 * Cloudflareのエッジ自身によって設定され、クライアント側からは偽装できない
 * （Cloudflareが受信時に上書きするため、リクエスト元がこのヘッダーへ任意の値を
 * 送っても無視される）。
 *
 * `X-Forwarded-For` は信用しない。クライアントが自由に設定できるヘッダーであり、
 * これを信用するとレート制限キーを毎リクエストごとに詐称してすり抜けられてしまう。
 *
 * `CF-Connecting-IP` が無い場合（Cloudflareを経由しないローカルNodeサーバー等）は
 * 固定ラベルにフォールバックする。実際のCloudflare Workers本番環境でこの分岐に
 * 入ることは無い。
 */
export function getClientIp(c: Context): string {
  return c.req.header("CF-Connecting-IP") ?? "local-dev";
}
