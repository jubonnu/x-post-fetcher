import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePostAuthorFromUrl,
  normalizeUsername,
  isTargetUserPost,
  isPinnedPost,
  processPageHtmls,
} from "../src/scraping/x/postFilter.ts";
import { parseTweetArticle } from "../src/scraping/x/parseTweetDom.ts";
import type { RawPost } from "../src/scraping/x/parseTweetDom.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(resolve(here, "fixtures", name), "utf-8");

// ---- helpers ---------------------------------------------------------------

function makePost(overrides: Partial<Pick<RawPost, "sourceUrl" | "authorUsername" | "tweetId" | "publishedAt">>): RawPost {
  return {
    tweetId: overrides.tweetId ?? "9999999999999999999",
    authorId: null,
    authorUsername: overrides.authorUsername ?? "zabi_poc",
    authorDisplayName: null,
    bodyText: "本文",
    publishedAt: overrides.publishedAt ?? "2026-07-23T12:00:00.000Z",
    sourceUrl: overrides.sourceUrl ?? "https://x.com/zabi_poc/status/9999999999999999999",
    externalUrls: [],
    externalLinks: [],
    imageUrls: [],
    rawHtml: "",
    cleanedHtml: "",
  };
}

// ---- parsePostAuthorFromUrl -------------------------------------------------

describe("parsePostAuthorFromUrl", () => {
  it("https://x.com/username/status/id → username", () => {
    expect(parsePostAuthorFromUrl("https://x.com/foo/status/123")).toBe("foo");
  });

  it("https://twitter.com/username/status/id → username", () => {
    expect(parsePostAuthorFromUrl("https://twitter.com/bar/status/456")).toBe("bar");
  });

  it("相対URL /username/status/id → username", () => {
    expect(parsePostAuthorFromUrl("/baz/status/789")).toBe("baz");
  });

  it("/i/status/id は null（システムパス）", () => {
    expect(parsePostAuthorFromUrl("https://x.com/i/status/123")).toBeNull();
  });

  it("/home は null", () => {
    expect(parsePostAuthorFromUrl("https://x.com/home")).toBeNull();
  });

  it("/search は null", () => {
    expect(parsePostAuthorFromUrl("https://x.com/search?q=foo")).toBeNull();
  });

  it("別ドメインは null", () => {
    expect(parsePostAuthorFromUrl("https://example.com/foo/status/123")).toBeNull();
  });

  it("status なし URL は null", () => {
    expect(parsePostAuthorFromUrl("https://x.com/foo")).toBeNull();
  });

  it("大文字小文字は正規化前の文字列を返す", () => {
    expect(parsePostAuthorFromUrl("https://x.com/Foo_Bar/status/1")).toBe("Foo_Bar");
  });
});

// ---- normalizeUsername ------------------------------------------------------

describe("normalizeUsername", () => {
  it("@ を除去して小文字化", () => {
    expect(normalizeUsername("@Zabi_poc")).toBe("zabi_poc");
  });

  it("@ なしでも小文字化", () => {
    expect(normalizeUsername("ZABI_POC")).toBe("zabi_poc");
  });
});

// ---- isTargetUserPost -------------------------------------------------------

describe("isTargetUserPost", () => {
  it("1. TARGET_USER 本人投稿は採用", () => {
    const post = makePost({ sourceUrl: "https://x.com/zabi_poc/status/1", authorUsername: "zabi_poc" });
    expect(isTargetUserPost(post, "zabi_poc")).toBe(true);
  });

  it("2. 別ユーザーの投稿は除外", () => {
    const post = makePost({ sourceUrl: "https://x.com/other_user/status/1", authorUsername: "other_user" });
    expect(isTargetUserPost(post, "zabi_poc")).toBe(false);
  });

  it("3. sourceUrl だけ別ユーザーなら除外", () => {
    const post = makePost({ sourceUrl: "https://x.com/other_user/status/1", authorUsername: "zabi_poc" });
    expect(isTargetUserPost(post, "zabi_poc")).toBe(false);
  });

  it("authorUsername が大文字混じりでも一致", () => {
    const post = makePost({ sourceUrl: "https://x.com/Zabi_POC/status/1", authorUsername: "Zabi_POC" });
    expect(isTargetUserPost(post, "zabi_poc")).toBe(true);
  });

  it("targetUser に @ が付いても一致", () => {
    const post = makePost({ sourceUrl: "https://x.com/zabi_poc/status/1", authorUsername: "zabi_poc" });
    expect(isTargetUserPost(post, "@zabi_poc")).toBe(true);
  });

  it("authorUsername が null なら sourceUrl だけで判定", () => {
    const post = makePost({ sourceUrl: "https://x.com/zabi_poc/status/1", authorUsername: null as any });
    expect(isTargetUserPost(post, "zabi_poc")).toBe(true);
  });

  it("sourceUrl が /i/status/ → 除外（システムパス）", () => {
    const post = makePost({ sourceUrl: "https://x.com/i/status/1", authorUsername: "zabi_poc" });
    expect(isTargetUserPost(post, "zabi_poc")).toBe(false);
  });
});

// ---- isPinnedPost -----------------------------------------------------------

describe("isPinnedPost", () => {
  it("4. 固定投稿（Pinned / 英語UI）は true", () => {
    expect(isPinnedPost(fixture("pinned-en.html"))).toBe(true);
  });

  it("5. 固定投稿（固定済み / 日本語UI）は true", () => {
    expect(isPinnedPost(fixture("pinned-ja.html"))).toBe(true);
  });

  it("通常投稿は false", () => {
    expect(isPinnedPost(fixture("single-product.html"))).toBe(false);
  });

  it("他ユーザー投稿（固定マーカーなし）は false", () => {
    expect(isPinnedPost(fixture("other-user.html"))).toBe(false);
  });
});

// ---- quote tweet ------------------------------------------------------------

describe("quote tweet 内の別ユーザー", () => {
  it("6. 親投稿が TARGET_USER なら採用（ネスト記事のauthorは無視）", () => {
    const post = parseTweetArticle(fixture("quote-tweet.html"));
    expect(post).not.toBeNull();
    expect(post!.authorUsername).toBe("zabi_poc");
    expect(post!.tweetId).toBe("2000000000000000002");
    expect(isTargetUserPost(post!, "zabi_poc")).toBe(true);
  });
});

// ---- processPageHtmls (スクロール挙動) --------------------------------------

describe("processPageHtmls", () => {
  const TARGET = "zabi_poc";

  function makeArticleHtml(id: string, username: string, datetime: string, pinned = false): string {
    const socialCtx = pinned ? `<div data-testid="socialContext">Pinned</div>` : "";
    return `
<article data-testid="tweet" role="article">
  ${socialCtx}
  <div data-testid="User-Name">
    <a href="/${username}" role="link"><span>${username}</span></a>
    <a href="/${username}/status/${id}">
      <time datetime="${datetime}">${datetime}</time>
    </a>
  </div>
  <div data-testid="tweetText" lang="ja" dir="auto"><span>投稿 ${id}</span></div>
</article>`;
  }

  it("7. 候補15件中3件除外 → 2回目で有効15件に到達", () => {
    const collected = new Map<string, RawPost>();

    // 1回目: 15件（3件は別ユーザー or 固定）
    const batch1 = [
      makeArticleHtml("1001", TARGET, "2026-07-23T12:00:00.000Z"),
      makeArticleHtml("1002", TARGET, "2026-07-23T11:00:00.000Z"),
      makeArticleHtml("1003", "other_user", "2026-07-23T10:00:00.000Z"), // 除外
      makeArticleHtml("1004", TARGET, "2026-07-23T09:00:00.000Z"),
      makeArticleHtml("1005", TARGET, "2026-07-23T08:00:00.000Z"),
      makeArticleHtml("1006", TARGET, "2026-07-23T07:00:00.000Z"),
      makeArticleHtml("1007", TARGET, "2026-07-23T06:00:00.000Z"),
      makeArticleHtml("1008", TARGET, "2026-07-23T05:00:00.000Z"),
      makeArticleHtml("1009", TARGET, "2026-07-23T04:00:00.000Z"),
      makeArticleHtml("1010", TARGET, "2026-07-23T03:00:00.000Z"),
      makeArticleHtml("1011", TARGET, "2026-07-23T02:00:00.000Z"),
      makeArticleHtml("1012", TARGET, "2026-07-23T01:00:00.000Z"),
      makeArticleHtml("1013", "1003", "2026-07-22T23:00:00.000Z", true), // 固定除外（idは重複しないが固定）
      makeArticleHtml("1014", TARGET, "2026-07-22T22:00:00.000Z"),
      makeArticleHtml("1015", "another_user", "2026-07-22T21:00:00.000Z"), // 除外
    ];
    const r1 = processPageHtmls(batch1, TARGET, collected);
    expect(r1.skippedWrongAuthor).toBe(2);
    expect(r1.skippedPinned).toBe(1);
    expect(collected.size).toBe(12); // 15 - 3

    // 2回目: 追加スクロールで3件追加
    const batch2 = [
      makeArticleHtml("1016", TARGET, "2026-07-22T20:00:00.000Z"),
      makeArticleHtml("1017", TARGET, "2026-07-22T19:00:00.000Z"),
      makeArticleHtml("1018", TARGET, "2026-07-22T18:00:00.000Z"),
    ];
    processPageHtmls(batch2, TARGET, collected);
    expect(collected.size).toBe(15);
  });

  it("8. 最大スクロール到達で有効件数12件 → 12件返却（警告は fetchTweets 側）", () => {
    const collected = new Map<string, RawPost>();
    const batch: string[] = [];
    for (let i = 1; i <= 12; i++) {
      batch.push(makeArticleHtml(`200${i}`, TARGET, `2026-07-23T${String(i).padStart(2, "0")}:00:00.000Z`));
    }
    processPageHtmls(batch, TARGET, collected);
    // MAX_POSTS=15 に届かなかった場合でも有効分は保持される
    expect(collected.size).toBe(12);
  });

  it("9. 結果は publishedAt 降順（fetchTweets 側でソート）", () => {
    const collected = new Map<string, RawPost>();
    processPageHtmls(
      [
        makeArticleHtml("3001", TARGET, "2026-07-23T08:00:00.000Z"),
        makeArticleHtml("3002", TARGET, "2026-07-23T12:00:00.000Z"),
        makeArticleHtml("3003", TARGET, "2026-07-23T06:00:00.000Z"),
      ],
      TARGET,
      collected
    );
    const posts = [...collected.values()].sort((a, b) => {
      const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return tb - ta;
    });
    expect(posts[0].tweetId).toBe("3002"); // 最新
    expect(posts[1].tweetId).toBe("3001");
    expect(posts[2].tweetId).toBe("3003"); // 最古
  });

  it("10. externalPostId 重複は1件に統合", () => {
    const collected = new Map<string, RawPost>();
    const html = makeArticleHtml("4001", TARGET, "2026-07-23T12:00:00.000Z");
    processPageHtmls([html, html, html], TARGET, collected); // 同じ記事を3回
    expect(collected.size).toBe(1);
  });
});

// ---- 展開済みURL ------------------------------------------------------------

describe("expanded URL 抽出", () => {
  it("11. data-expanded-url がある場合は t.co でなく展開済みURLを保存", () => {
    const post = parseTweetArticle(fixture("expanded-url.html"));
    expect(post).not.toBeNull();
    expect(post!.externalUrls).toContain("https://docs.google.com/forms/d/e/expanded_form");
    expect(post!.externalUrls).not.toContain("https://t.co/EXPANDED1");
  });

  it("data-expanded-url がない場合は href（t.co）を保存（既存挙動を維持）", () => {
    // single-product.html は data-expanded-url なし → t.co のまま
    const post = parseTweetArticle(fixture("single-product.html"));
    expect(post!.externalUrls).toContain("https://t.co/abcDEF123");
  });

  it("同一展開済みURLの重複は除去", () => {
    const html = `
<article data-testid="tweet" role="article">
  <div data-testid="User-Name">
    <a href="/zabi_poc/status/5001">
      <time datetime="2026-07-23T12:00:00.000Z">7月23日</time>
    </a>
  </div>
  <div data-testid="tweetText">
    <a href="https://t.co/AAA" data-expanded-url="https://example.com/same">link1</a>
    <a href="https://t.co/BBB" data-expanded-url="https://example.com/same">link2</a>
  </div>
</article>`;
    const post = parseTweetArticle(html);
    const count = post!.externalUrls.filter((u) => u === "https://example.com/same").length;
    expect(count).toBe(1);
  });
});

// ---- cleanedHtml ------------------------------------------------------------

describe("cleanedHtml", () => {
  it("12a. tweet本文テキストとリンクは残る", () => {
    const post = parseTweetArticle(fixture("single-product.html"));
    expect(post!.cleanedHtml).toContain("ドラゴンスターで");
    expect(post!.cleanedHtml).toContain("tweetText");
  });

  it("12b. img は除去済み（既存挙動を維持）", () => {
    const post = parseTweetArticle(fixture("single-product.html"));
    expect(post!.cleanedHtml).not.toContain("<img");
  });

  it("12c. svg は除去", () => {
    const html = `
<article data-testid="tweet" role="article">
  <div data-testid="User-Name">
    <a href="/zabi_poc/status/6001">
      <time datetime="2026-07-23T12:00:00.000Z">7月23日</time>
    </a>
  </div>
  <svg viewBox="0 0 24 24"><path d="M12"/></svg>
  <div data-testid="tweetText"><span>SVGテスト</span></div>
</article>`;
    const post = parseTweetArticle(html);
    expect(post!.cleanedHtml).not.toContain("<svg");
  });

  it("12d. button は除去", () => {
    const html = `
<article data-testid="tweet" role="article">
  <div data-testid="User-Name">
    <a href="/zabi_poc/status/6002">
      <time datetime="2026-07-23T12:00:00.000Z">7月23日</time>
    </a>
  </div>
  <button>いいね</button>
  <div data-testid="tweetText"><span>ボタンテスト</span></div>
</article>`;
    const post = parseTweetArticle(html);
    expect(post!.cleanedHtml).not.toContain("<button");
  });

  it("12e. class / style 属性は除去", () => {
    const html = `
<article data-testid="tweet" role="article">
  <div data-testid="User-Name" class="css-123" style="color:red">
    <a href="/zabi_poc/status/6003">
      <time datetime="2026-07-23T12:00:00.000Z">7月23日</time>
    </a>
  </div>
  <div data-testid="tweetText" class="r-something" style="font-size:14px"><span>属性テスト</span></div>
</article>`;
    const post = parseTweetArticle(html);
    expect(post!.cleanedHtml).not.toContain('class=');
    expect(post!.cleanedHtml).not.toContain('style=');
  });

  it("12f. rawHtml は元の img/class/style を保持する", () => {
    // image-react.html には img が含まれ rawHtml に残る
    const withImg = parseTweetArticle(fixture("image-react.html"));
    expect(withImg!.rawHtml).toContain("pbs.twimg.com/media");
  });
});
