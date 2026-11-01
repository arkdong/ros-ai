import type { PostPlatform, PostView } from './types.js';

/** Platforms a Post block reads. Xiaohongshu is read in ros.ai's signed-in browser, after the person logs in there once
 * (Plugins › Xiaohongshu); the others need no login. */
export const POST_PLATFORMS = ['youtube', 'reddit', 'hackernews', 'github', 'xiaohongshu'] as const satisfies readonly PostPlatform[];
export const POST_PLATFORM_NAMES = { youtube: 'YouTube', reddit: 'Reddit', hackernews: 'Hacker News', github: 'GitHub', xiaohongshu: 'Xiaohongshu' } as const satisfies Record<PostPlatform, string>;
/** Platforms read in the signed-in browser, which need the person's login first. */
export const SIGNED_IN_PLATFORMS = ['xiaohongshu'] as const satisfies readonly PostPlatform[];
export type SignedInPlatform = (typeof SIGNED_IN_PLATFORMS)[number];

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
  if (name === 'xiaohongshu.com' || name === 'xhslink.com') return 'xiaohongshu';
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
    xiaohongshu: [['likes', 'likes'], ['saves', 'saves'], ['comments', 'comments']],
  };
  return order[post.platform].flatMap(([key, label]) => post.counts[key] === undefined ? [] : [{ key, label, value: post.counts[key]! }]);
}

/** A count as Xiaohongshu writes it, as a number: "1.2万" is 12,000, "10+" is 10, "" is none. */
export function chineseCount(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : undefined;
  if (typeof value !== 'string') return undefined;
  const match = /^\s*([\d.,]+)\s*(万|w|千|k|亿)?\+?\s*$/iu.exec(value);
  if (!match) return undefined;
  const base = Number(match[1].replace(/,/gu, ''));
  if (!Number.isFinite(base)) return undefined;
  const unit = match[2]?.toLowerCase();
  return Math.round(base * (unit === '万' || unit === 'w' ? 10_000 : unit === '千' || unit === 'k' ? 1_000 : unit === '亿' ? 100_000_000 : 1));
}
