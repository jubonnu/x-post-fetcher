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

export interface RecoveryCursor {
  externalPostId: string | null;
  publishedAt: string | null;
}

export interface ProcessResult {
  added: number;
  /** 既知（knownExternalPostIds に含まれる）本人投稿として検出した件数（今回コール分）。 */
  known: number;
  skippedPinned: number;
  skippedWrongAuthor: number;
  /**
   * 呼び出し時点の consecutiveKnownStreak を引き継ぎ、更新した値。差分取得の境界検出
   * （連続何件既知投稿が続いたか）に使う。knownExternalPostIds 未指定時は常に 0。
   */
  consecutiveKnownStreak: number;
  /**
   * recovery cursor（前回走査未完了時の到達地点）に到達したか（一度trueになったら以後もtrue）。
   * `recoveryCursor`未指定なら常に呼び出し時点の値をそのまま返す（cursorなし＝ゲーティング不要）。
   */
  cursorReached: boolean;
  /** 今回コールで見つかった有効な本人投稿（既知/新規問わず）のうち最古の1件。無ければnull。 */
  oldestSeen: { externalPostId: string; publishedAt: string } | null;
}

export interface ProcessPageHtmlsOptions {
  /**
   * 差分取得用の既知 externalPostId 集合。指定時、含まれる本人投稿は`collected`に追加せず
   * （＝再送しない）、`known`件数・`consecutiveKnownStreak`のみ更新する。未指定/空なら
   * 全件を新規として扱う（＝従来の「最新N件取得」互換動作）。
   */
  knownExternalPostIds?: ReadonlySet<string>;
  /**
   * スクロール間で呼び出し元が持ち回る「評価済みID」集合。X側は`$$eval`のたびに現在DOM上の
   * 全記事を再取得するため、同じ記事が複数回のコールにまたがって渡ってくる。この集合が無いと
   * skippedPinned/skippedWrongAuthor が再走査のたびに重複カウントされてしまう。
   */
  seenArticleIds?: Set<string>;
  /** 前回コール終了時点の consecutiveKnownStreak（スクロール間で引き継ぐ）。 */
  consecutiveKnownStreak?: number;
  /**
   * recovery cursor（前回走査未完了時に保存した「今回どこまで遡ったか」）。未指定/nullなら
   * cursorゲーティングを行わない（＝境界検出は常に許可、cursorReachedは常にtrue）。
   */
  recoveryCursor?: RecoveryCursor | null;
  /** 前回コール終了時点の cursorReached（スクロール間で引き継ぐ）。 */
  cursorReached?: boolean;
}

/**
 * 1スクロール分の article HTML 配列を処理し、有効な新規投稿を collected に追加する。
 * Playwright 依存なしの純関数なのでユニットテスト可能。
 */
export function processPageHtmls(
  htmls: string[],
  targetUser: string,
  collected: Map<string, RawPost>,
  options: ProcessPageHtmlsOptions = {}
): ProcessResult {
  const knownExternalPostIds = options.knownExternalPostIds;
  const seenArticleIds = options.seenArticleIds ?? new Set<string>();
  let consecutiveKnownStreak = options.consecutiveKnownStreak ?? 0;
  const recoveryCursor = options.recoveryCursor ?? null;
  let cursorReached = options.cursorReached ?? !recoveryCursor;

  let added = 0;
  let known = 0;
  let skippedPinned = 0;
  let skippedWrongAuthor = 0;
  let oldestSeen: { externalPostId: string; publishedAt: string } | null = null;

  for (const html of htmls) {
    try {
      if (isPinnedPost(html)) {
        const idMatch = html.match(/\/status\/(\d+)/);
        const externalPostId = idMatch?.[1] ?? null;
        if (externalPostId) {
          if (seenArticleIds.has(externalPostId)) continue;
          seenArticleIds.add(externalPostId);
        }
        console.log(JSON.stringify({ action: "skipped", reason: "pinned_post", externalPostId: externalPostId ?? "unknown" }));
        skippedPinned++;
        continue;
      }

      const post = parseTweetArticle(html);
      if (!post?.tweetId) continue;

      if (seenArticleIds.has(post.tweetId)) continue; // 再走査による重複評価を防ぐ
      seenArticleIds.add(post.tweetId);

      if (!isTargetUserPost(post, targetUser)) {
        console.log(
          JSON.stringify({ action: "skipped", reason: "wrong_author", externalPostId: post.tweetId, authorUsername: post.authorUsername })
        );
        skippedWrongAuthor++;
        continue;
      }

      if (post.publishedAt && (!oldestSeen || Date.parse(post.publishedAt) < Date.parse(oldestSeen.publishedAt))) {
        oldestSeen = { externalPostId: post.tweetId, publishedAt: post.publishedAt };
      }

      if (!cursorReached && recoveryCursor) {
        if (recoveryCursor.externalPostId && post.tweetId === recoveryCursor.externalPostId) {
          cursorReached = true;
        } else if (
          recoveryCursor.publishedAt &&
          post.publishedAt &&
          Date.parse(post.publishedAt) <= Date.parse(recoveryCursor.publishedAt)
        ) {
          cursorReached = true;
        }
      }

      if (knownExternalPostIds && knownExternalPostIds.has(post.tweetId)) {
        known++;
        consecutiveKnownStreak++;
        continue; // 既知投稿は再送しない（collected へ追加しない）
      }

      consecutiveKnownStreak = 0;
      if (!collected.has(post.tweetId)) {
        collected.set(post.tweetId, post);
        added++;
      }
    } catch (e) {
      console.warn(`[fetch] 1件の抽出に失敗（スキップ）: ${e instanceof Error ? e.message : e}`);
    }
  }

  return { added, known, skippedPinned, skippedWrongAuthor, consecutiveKnownStreak, cursorReached, oldestSeen };
}
