/**
 * 認証APIのレート制限（固定ウィンドウ、Worker isolateごとのメモリ内カウンタ）。
 *
 * 既知の限界（production環境ではベストエフォートであることを明記する）:
 * Cloudflare Workersは同一isolateが複数エッジロケーションへ分散するため、
 * このカウンタは「単一isolateのベストエフォート」であり、エッジ全体で厳密に分散共有される
 * ものではない。本格的な分散レート制限にはCloudflareのネイティブRate Limiting bindingや
 * Durable Objectsが必要（Mobile-G3または一般公開前に移行を検討する課題として登録）。
 *
 * メモリ安全性: キー（IP/deviceId）を無制限に保持しないよう、期限切れバケットを定期的に
 * 掃除し、かつ最大件数を超えたら古いものから強制的に削除する（悪意ある大量の偽IP等で
 * メモリを圧迫させる攻撃への耐性のため）。
 */
interface Bucket {
  count: number;
  windowStartMs: number;
}

const buckets = new Map<string, Bucket>();

const MAX_BUCKETS = 10_000;
const SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt = 0;

function sweepExpiredBuckets(now: number, windowMsHint: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  const staleAfterMs = windowMsHint * 2;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStartMs > staleAfterMs) {
      buckets.delete(key);
    }
  }
}

function enforceMaxBuckets(): void {
  if (buckets.size <= MAX_BUCKETS) return;
  const overflow = buckets.size - MAX_BUCKETS;
  let i = 0;
  for (const key of buckets.keys()) {
    if (i++ >= overflow) break;
    buckets.delete(key);
  }
}

export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  sweepExpiredBuckets(now, windowMs);

  const bucket = buckets.get(key);
  let allowed: boolean;

  if (!bucket || now - bucket.windowStartMs >= windowMs) {
    buckets.set(key, { count: 1, windowStartMs: now });
    allowed = true;
  } else if (bucket.count >= limit) {
    allowed = false;
  } else {
    bucket.count += 1;
    allowed = true;
  }

  enforceMaxBuckets();
  return allowed;
}

/** テスト専用: バケット状態をリセットする。 */
export function __resetRateLimitForTests(): void {
  buckets.clear();
  lastSweepAt = 0;
}
