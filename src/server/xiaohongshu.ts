import type { Page } from 'playwright-core';
import { chineseCount, MAX_POST_COMMENTS, MAX_POST_HITS, MAX_POST_PHOTOS, POST_COMMENT_TEXT, POST_TEXT } from '../shared/posts.js';
import type { PostComment, PostHit, PostView } from '../shared/types.js';
import type { ReadPost, PostSort } from './posts.js';
import type { SignedInBrowser } from './signed-in-browser.js';
import { StoreError } from './store.js';

/** Xiaohongshu (小红书) notes, read in ros.ai's signed-in browser the way the person's own browser shows them: the
 * search page and the note page load as usual, and ros.ai keeps what those pages fetch for themselves (the search
 * results, the note and its first comments). Nothing is signed or called behind the site's back. */

const HOME = 'https://www.xiaohongshu.com';
const SEARCH_API = /\/api\/sns\/web\/v1\/search\/notes/u, COMMENTS_API = /\/api\/sns\/web\/v2\/comment\/page/u;
const RESULTS_MS = 12_000, COMMENTS_MS = 5_000;

const text = (value: unknown, limit: number) => typeof value === 'string' ? value.replace(/\r\n?/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim().slice(0, limit) : '';
const https = (url: unknown) => typeof url === 'string' && /^(https?:)?\/\//u.test(url) ? url.replace(/^(https?:)?\/\//u, 'https://') : undefined;
const iso = (ms: unknown) => typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms < 1e12 ? ms * 1000 : ms).toISOString() : undefined;
/** A note's text without Xiaohongshu's topic markup: "#火锅[话题]#" reads "#火锅". */
export const noteText = (value: unknown, limit = POST_TEXT) => text(typeof value === 'string' ? value.replace(/#([^#[\]\n]+)\[(话题|地点)\]#/gu, '#$1').replace(/\[([^\]\n]{1,8})R\]/gu, '[$1]') : value, limit);
/** A note's link: its page, with the token Xiaohongshu asks for when a note is opened from search. */
export const noteLink = (id: string, token?: string, source = 'pc_search') => `${HOME}/explore/${encodeURIComponent(id)}${token ? `?${new URLSearchParams({ xsec_token: token, xsec_source: source })}` : ''}`;
/** The note id in a Xiaohongshu link: /explore/<id>, /discovery/item/<id> or /user/profile/<user>/<id>. */
export function noteId(link: string): string | undefined {
  try { return /\/(?:explore|discovery\/item|user\/profile\/[0-9a-f]+)\/([0-9a-f]{24})(?:[/?#]|$)/iu.exec(new URL(link).pathname + '?')?.[1]; } catch { return undefined; }
}

type Card = { display_title?: string; title?: string; type?: string; user?: { nickname?: string; nick_name?: string; user_id?: string }; interact_info?: { liked_count?: string | number }; cover?: { url_default?: string; url_pre?: string; url?: string; info_list?: { url?: string }[] } };
type Item = { id?: string; xsec_token?: string; model_type?: string; note_card?: Card };
/** The notes a search page fetched for itself (or put in its own state), as search hits. */
export function searchHits(items: Item[], limit: number, sort: PostSort): PostHit[] {
  const seen = new Set<string>();
  const hits = items.flatMap(item => {
    const card = item.note_card, id = item.id;
    if (!card || !id || (item.model_type && item.model_type !== 'note') || seen.has(id)) return [];
    seen.add(id);
    const likes = chineseCount(card.interact_info?.liked_count);
    return [{ platform: 'xiaohongshu', url: noteLink(id, item.xsec_token), title: text(card.display_title ?? card.title, 300) || 'Untitled note', author: text(card.user?.nickname ?? card.user?.nick_name, 100) || undefined, counts: likes === undefined ? {} : { likes }, thumbnail: https(card.cover?.url_default ?? card.cover?.url_pre ?? card.cover?.url ?? card.cover?.info_list?.at(-1)?.url), ...(card.type === 'video' ? { snippet: 'Video note' } : {}) } satisfies PostHit];
  });
  return (sort === 'top' ? hits.sort((a, b) => (b.counts.likes ?? 0) - (a.counts.likes ?? 0)) : hits).slice(0, limit);
}

type Note = { noteId?: string; id?: string; type?: string; title?: string; desc?: string; time?: number; ipLocation?: string; user?: { nickname?: string; nickName?: string; userId?: string }; interactInfo?: { likedCount?: string | number; collectedCount?: string | number; commentCount?: string | number }; imageList?: { urlDefault?: string; urlPre?: string; url?: string; width?: number; height?: number; infoList?: { imageScene?: string; url?: string }[] }[]; tagList?: { name?: string }[]; video?: { capa?: { duration?: number } } };
type RawComment = { content?: string; like_count?: string | number; create_time?: number; user_info?: { nickname?: string }; sub_comments?: RawComment[] };
/** One note as its page holds it, with the comments the page fetched, as a Post block keeps it. */
export function notePost(note: Note, link: string, comments: RawComment[]): ReadPost {
  const id = note.noteId ?? note.id ?? noteId(link);
  if (!id) throw new StoreError('That Xiaohongshu page holds no note.', 404);
  const token = (() => { try { return new URL(link).searchParams.get('xsec_token') ?? undefined; } catch { return undefined; } })();
  const photos = (note.imageList ?? []).flatMap(image => {
    const url = https(image.urlDefault ?? image.infoList?.find(item => item.imageScene === 'WB_DFT')?.url ?? image.url ?? image.urlPre);
    return url ? [{ url, ...(Number.isInteger(image.width) && image.width! > 0 ? { width: image.width } : {}), ...(Number.isInteger(image.height) && image.height! > 0 ? { height: image.height } : {}) }] : [];
  }).slice(0, MAX_POST_PHOTOS);
  const kept: PostComment[] = [];
  const add = (comment: RawComment, depth: number) => {
    if (kept.length >= MAX_POST_COMMENTS) return;
    const body = noteText(comment.content, POST_COMMENT_TEXT);
    if (body) kept.push({ author: text(comment.user_info?.nickname, 100) || 'Someone', text: body, ...(chineseCount(comment.like_count) !== undefined ? { likes: chineseCount(comment.like_count) } : {}), ...(iso(comment.create_time) ? { at: iso(comment.create_time) } : {}), ...(depth ? { depth } : {}) });
    for (const reply of (comment.sub_comments ?? []).slice(0, 2)) add(reply, depth + 1);
  };
  for (const comment of comments) add(comment, 0);
  const video = note.type === 'video', counts = Object.fromEntries(Object.entries({ likes: chineseCount(note.interactInfo?.likedCount), saves: chineseCount(note.interactInfo?.collectedCount), comments: chineseCount(note.interactInfo?.commentCount) }).filter(([, value]) => value !== undefined)) as PostView['counts'];
  const tags = (note.tagList ?? []).map(tag => text(tag.name, 100)).filter(Boolean).slice(0, 30);
  return { post: {
    platform: 'xiaohongshu', shape: video ? 'video' : photos.length ? 'photo' : 'text', url: noteLink(id, token, 'pc_share'), id,
    ...(text(note.title, 500) ? { title: text(note.title, 500) } : {}), text: noteText(note.desc),
    author: { name: text(note.user?.nickname ?? note.user?.nickName, 200) || 'Someone', ...(note.user?.userId ? { url: `${HOME}/user/profile/${encodeURIComponent(note.user.userId)}` } : {}) },
    ...(text(note.ipLocation, 200) ? { community: text(note.ipLocation, 200) } : {}), ...(iso(note.time) ? { postedAt: iso(note.time) } : {}),
    counts, photos, ...(tags.length ? { tags } : {}), ...(kept.length ? { comments: kept } : {}),
    ...(video && typeof note.video?.capa?.duration === 'number' ? { duration: note.video.capa.duration } : {}),
    readAt: new Date().toISOString(), ...(video ? { notice: 'The video plays on Xiaohongshu; ros.ai keeps its cover, text and comments.' } : {}),
  } };
}

/** What a reader collects from the page's own requests while it loads. */
function collect(page: Page, pattern: RegExp): unknown[] {
  const bodies: unknown[] = [];
  page.on('response', response => { if (pattern.test(response.url()) && response.ok()) void response.json().then(body => bodies.push(body), () => undefined); });
  return bodies;
}
const until = async (page: Page, ready: () => boolean, ms: number) => { for (let waited = 0; !ready() && waited < ms; waited += 250) await page.waitForTimeout(250); };
/** Xiaohongshu answers code 0 and success when it gave what was asked; 300011 and 461 when it wants a check. */
function answered(body: unknown, signedIn: SignedInBrowser): { items?: Item[]; comments?: RawComment[] } | undefined {
  const reply = body as { code?: number; success?: boolean; msg?: string; data?: { items?: Item[]; comments?: RawComment[] } };
  if (reply?.code === 300011 || reply?.code === 461 || reply?.code === 300013) throw new StoreError('Xiaohongshu asked for a check that a person is there.', 429);
  if (reply?.code === -100 || reply?.code === -101) { signedIn.signedOut('xiaohongshu'); throw new StoreError('Xiaohongshu says ros.ai is no longer logged in. Ask the person to log in again in Plugins › Xiaohongshu.', 401); }
  return reply?.success === false ? undefined : reply?.data;
}

export async function searchXiaohongshu(signedIn: SignedInBrowser, query: string, limit: number, sort: PostSort): Promise<PostHit[]> {
  const count = Math.max(1, Math.min(MAX_POST_HITS, limit));
  return signedIn.run('xiaohongshu', 'search', async page => {
    const bodies = collect(page, SEARCH_API);
    await page.goto(`${HOME}/search_result?${new URLSearchParams({ keyword: query, source: 'web_search_result_notes' })}`, { waitUntil: 'domcontentloaded' });
    if (signedIn.checkPage('xiaohongshu', page.url())) throw new StoreError('Xiaohongshu asked for a check.', 429);
    await until(page, () => bodies.length > 0 || signedIn.checkPage('xiaohongshu', page.url()), RESULTS_MS);
    if (signedIn.checkPage('xiaohongshu', page.url())) throw new StoreError('Xiaohongshu asked for a check.', 429);
    const items = () => bodies.flatMap(body => answered(body, signedIn)?.items ?? []);
    // A second screenful when the first held too few.
    if (bodies.length && items().length < count) { const before = bodies.length; await page.mouse.wheel(0, 4000); await until(page, () => bodies.length > before, 6_000); }
    let found = items();
    // Without a request seen, the results the page put in its own state.
    if (!found.length) found = await page.evaluate(() => {
      const state = (window as unknown as { __INITIAL_STATE__?: { search?: { feeds?: unknown } } }).__INITIAL_STATE__?.search?.feeds as { _value?: unknown; value?: unknown } | unknown[] | undefined;
      const feeds = Array.isArray(state) ? state : (state as { _value?: unknown })?._value ?? (state as { value?: unknown })?.value;
      try { return JSON.parse(JSON.stringify(Array.isArray(feeds) ? feeds : [])) as Item[]; } catch { return []; }
    }).catch(() => [] as Item[]);
    if (!found.length && signedIn.checkPage('xiaohongshu', page.url())) throw new StoreError('Xiaohongshu asked for a check.', 429);
    return searchHits(found, count, sort);
  });
}

export async function readXiaohongshu(signedIn: SignedInBrowser, link: string): Promise<ReadPost> {
  return signedIn.run('xiaohongshu', 'read', async page => {
    const bodies = collect(page, COMMENTS_API);
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    if (signedIn.checkPage('xiaohongshu', page.url())) throw new StoreError('Xiaohongshu asked for a check.', 429);
    const id = noteId(page.url()) ?? noteId(link);
    const note = await page.evaluate(wanted => {
      const map = (window as unknown as { __INITIAL_STATE__?: { note?: { noteDetailMap?: unknown } } }).__INITIAL_STATE__?.note?.noteDetailMap as Record<string, { note?: unknown }> & { _value?: Record<string, { note?: unknown }> } | undefined;
      const notes = map?._value ?? map;
      const entry = notes ? (wanted && notes[wanted]) || Object.values(notes).find(item => item && typeof item === 'object' && 'note' in item && item.note && Object.keys(item.note as object).length) : undefined;
      try { return entry?.note ? JSON.parse(JSON.stringify(entry.note)) as unknown : null; } catch { return null; }
    }, id ?? null).catch(() => null) as Note | null;
    if (!note || !(note.noteId ?? note.id ?? id)) throw new StoreError(signedIn.signedIn('xiaohongshu') ? 'Xiaohongshu did not show that note. It may be deleted or private, or the link may need the token it had when it was shared; open it from a search instead.' : 'Xiaohongshu shows that note only to people who are logged in. Log in once in Plugins › Xiaohongshu.', 404);
    await until(page, () => bodies.length > 0, COMMENTS_MS);
    const comments = bodies.flatMap(body => { try { return answered(body, signedIn)?.comments ?? []; } catch { return []; } });
    return notePost(note, page.url().includes('xsec_token') ? page.url() : link, comments);
  });
}
