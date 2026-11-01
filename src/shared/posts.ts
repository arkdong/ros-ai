import type { PostPlatform, PostView } from './types.js';

/** Platforms a Post block reads. Slice 1 has the ones that need no login; Xiaohongshu, X and the rest come with
 * ros.ai's signed-in browser. */
export const POST_PLATFORMS = ['youtube', 'reddit', 'hackernews', 'github'] as const satisfies readonly PostPlatform[];
export const POST_PLATFORM_NAMES = { youtube: 'YouTube', reddit: 'Reddit', hackernews: 'Hacker News', github: 'GitHub' } as const satisfies Record<PostPlatform, string>;

/** Limits on what one Post block keeps. */
export const POST_TEXT = 20_000;
export const POST_COMMENT_TEXT = 2_000;
export const MAX_POST_COMMENTS = 20;
export const MAX_POST_PHOTOS = 9;
/** Subtitles kept in the block itself when the project has no folder to save them in. */
export const POST_SUBTITLES_KEPT = 20_000;
/** The most posts one search returns and one ros_add_posts call adds. */
export const MAX_POST_HITS = 20;
export const MAX_POSTS_ADDED = 12;

const host = (url: URL) => url.hostname.toLowerCase().replace(/^(www|m|old|new|np|music)\./u, '');

/** Which platform a link is from, or undefined for a link no Post block reads. */
export function postPlatform(link: string): PostPlatform | undefined {
  let url: URL;
  try { url = new URL(link.trim()); } catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const name = host(url);
  if (name === 'youtube.com' || name === 'youtu.be' || name === 'youtube-nocookie.com') return 'youtube';
  if (name === 'reddit.com' || name === 'redd.it') return 'reddit';
  if (name === 'news.ycombinator.com') return 'hackernews';
  if (name === 'github.com') return 'github';
  return undefined;
}

/** A count as the platforms show it: 1,204 or 3.1k or 2.4M. */
export function shortCount(value: number | undefined): string {
  if (value === undefined) return '';
  const size = Math.abs(value);
  if (size < 10_000) return value.toLocaleString('en-US');
  if (size < 1_000_000) return `${(value / 1000).toFixed(size < 100_000 ? 1 : 0).replace(/\.0$/u, '')}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, '')}M`;
}

/** A video's length as 18:42 or 1:02:05. */
export function duration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '';
  const total = Math.round(seconds), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** The counts a card shows, in the order the platform shows them. */
export function postCounts(post: Pick<PostView, 'platform' | 'counts'>): { key: keyof PostView['counts']; label: string; value: number }[] {
  const order: Record<PostPlatform, [keyof PostView['counts'], string][]> = {
    youtube: [['views', 'views'], ['likes', 'likes'], ['comments', 'comments']],
    reddit: [['points', 'upvotes'], ['comments', 'comments']],
    hackernews: [['points', 'points'], ['comments', 'comments']],
    github: [['stars', 'stars'], ['forks', 'forks'], ['comments', 'comments']],
  };
  return order[post.platform].flatMap(([key, label]) => post.counts[key] === undefined ? [] : [{ key, label, value: post.counts[key]! }]);
}
