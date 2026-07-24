/** X タイムラインの投稿抽出に使うセレクタ・定数（CSSクラス名には依存しない） */

// 投稿を包む article は状態で2種類:
//  - ログイン時: React アプリ版 … <article data-testid="tweet">
//  - 未ログイン: Schema.org SSR 版 … <article data-tweet-id="...">
export const ARTICLE_SELECTOR = 'article[data-testid="tweet"], article[data-tweet-id]';

export const TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';
export const USER_NAME_SELECTOR = '[data-testid="User-Name"]';

/** cleanedHtml 生成時に除去するメディア/装飾要素 */
export const MEDIA_REMOVE_SELECTORS = [
  "img",
  "video",
  "source",
  "svg",
  'meta[itemprop="image"]',
  'meta[itemprop="thumbnailUrl"]',
  'meta[itemprop="contentUrl"]',
  '[data-testid="tweetPhoto"]',
  '[data-testid="videoPlayer"]',
  '[data-testid="videoComponent"]',
  '[data-testid="previewInterstitial"]',
  '[data-testid="card.layoutLarge.media"]',
  '[data-testid="card.layoutSmall.media"]',
];

/**
 * 投稿メディア画像と判定する URL パターン。
 * pbs.twimg.com/media のみ対象（profile_images=アバター や abs.twimg.com/emoji=絵文字SVG は除外）。
 */
export const TWEET_MEDIA_IMG = /pbs\.twimg\.com\/media\//i;
