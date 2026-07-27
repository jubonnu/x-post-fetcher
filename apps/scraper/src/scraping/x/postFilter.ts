import { parseTweetArticle, type RawPost } from "./parseTweetDom.ts";

/**
 * /username/status/id または https://x.com/username/status/id から username を返す。
 * システムパス・別ドメイン・/i/ パスは null。
 */
export function parsePostAuthorFromUrl(url: string): string | null {
  try {
    let pathname: string;
    if (/^https?:\/\//i.test(url)) {
      const u = new URL(url);
      if (!/^(x|twitter)\.com$/i.test(u.hostname)) return null;
      pathname = u.pathname;
    } else if (url.startsWith("/")) {
      pathname = url.split("?")[0].split("#")[0];
    } else {
      return null;
    }
    // /i/ サブパス・システムパスを除外
    if (/^\/(i\/|home\b|search\b|explore\b|notifications\b|messages\b)/i.test(pathname)) return null;
    // /{username}/status/{id} に一致する場合のみ
    const m = pathname.match(/^\/([A-Za-z0-9_]{1,50})\/status\/\d+/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function normalizeUsername(username: string): string {
  return username.replace(/^@/, "").toLowerCase().trim();
}

/** sourceUrl と authorUsername の両方を検証して TARGET_USER 本人投稿かを判定する。 */
export function isTargetUserPost(
  post: Pick<RawPost, "sourceUrl" | "authorUsername">,
  targetUser: string
): boolean {
  const target = normalizeUsername(targetUser);

  // sourceUrl は必ず検証（取得できなければ除外）
  const urlAuthor = parsePostAuthorFromUrl(post.sourceUrl);
  if (urlAuthor === null) return false;
  if (normalizeUsername(urlAuthor) !== target) return false;

  // authorUsername が取得できている場合は追加検証
  if (post.authorUsername != null && normalizeUsername(post.authorUsername) !== target) return false;

  return true;
}

/**
 * article HTML に固定投稿マーカーが含まれているか判定する。
 * data-testid="socialContext" 内の "Pinned" / "固定済み" を確認（日英両対応）。
 */
export function isPinnedPost(html: string): boolean {
  const m = html.match(/data-testid="socialContext"[^>]*>([\s\S]{0,500})/);
  if (!m) return false;
  return /Pinned|固定済み/.test(m[1]);
}

export interface ProcessResult {
  added: number;
  skippedPinned: number;
  skippedWrongAuthor: number;
}

/**
 * 1スクロール分の article HTML 配列を処理し、有効投稿を collected に追加する。
 * Playwright 依存なしの純関数なのでユニットテスト可能。
 */
export function processPageHtmls(
  htmls: string[],
  targetUser: string,
  collected: Map<string, RawPost>
): ProcessResult {
  let added = 0;
  let skippedPinned = 0;
  let skippedWrongAuthor = 0;

  for (const html of htmls) {
    try {
      if (isPinnedPost(html)) {
        const idMatch = html.match(/\/status\/(\d+)/);
        const externalPostId = idMatch?.[1] ?? "unknown";
        console.log(JSON.stringify({ action: "skipped", reason: "pinned_post", externalPostId }));
        skippedPinned++;
        continue;
      }

      const post = parseTweetArticle(html);
      if (!post?.tweetId) continue;

      if (!isTargetUserPost(post, targetUser)) {
        console.log(
          JSON.stringify({ action: "skipped", reason: "wrong_author", externalPostId: post.tweetId, authorUsername: post.authorUsername })
        );
        skippedWrongAuthor++;
        continue;
      }

      if (!collected.has(post.tweetId)) {
        collected.set(post.tweetId, post);
        added++;
      }
    } catch (e) {
      console.warn(`[fetch] 1件の抽出に失敗（スキップ）: ${e instanceof Error ? e.message : e}`);
    }
  }

  return { added, skippedPinned, skippedWrongAuthor };
}
