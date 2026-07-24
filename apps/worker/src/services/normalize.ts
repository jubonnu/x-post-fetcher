/**
 * 商品名・店舗名・支店の正規化（Worker 責務）。
 * Phase 2 は軽量: NFKC 正規化・空白圧縮・装飾記号除去まで。
 */

export const NORMALIZER_VERSION = "phase2-norm-1";

function normalizeBase(s: string | null | undefined): string | null {
  if (!s) return null;
  const n = s
    .normalize("NFKC")
    .replace(/[「」『』【】"'“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return n || null;
}

export function normalizeProductName(raw: string | null | undefined): string | null {
  return normalizeBase(raw);
}

export function normalizeStoreName(raw: string | null | undefined): string | null {
  const n = normalizeBase(raw);
  if (!n) return null;
  // オンライン/通販/店頭 等の販売チャネル語尾は支店側で扱うため店舗名からは削らない（Phase 2 は保持）
  return n;
}

export function normalizeStoreBranch(raw: string | null | undefined): string | null {
  return normalizeBase(raw);
}
