import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import { MAX_POST_COMMENTS, MAX_POST_HITS, MAX_POST_PHOTOS, POST_COMMENT_TEXT, POST_PLATFORM_NAMES, POST_PLATFORMS, POST_SUBTITLES_KEPT, POST_TEXT, postPlatform } from '../shared/posts.js';
import type { PostComment, PostHit, PostPlatform, PostView } from '../shared/types.js';
import { readLimited } from './papers.js';
import type { PythonRuntime } from './local-python.js';
import type { ProjectFolders } from './project-folders.js';
import { StoreError, type Store } from './store.js';
import type { WebFileFetcher } from './web-files.js';
import type { SignedInBrowser } from './signed-in-browser.js';
import { readXiaohongshu, searchXiaohongshu } from './xiaohongshu.js';

/** Posts for Post blocks. Xiaohongshu is read in ros.ai's signed-in browser (see xiaohongshu.ts); the rest without a
 * login: YouTube (through yt-dlp, which ros.ai installs into its
 * own Python), Reddit's and Hacker News' public JSON, and GitHub's API (with the GitHub plugin's sign-in when there is
 * one). Each read keeps the post as the platform showed it; photos and subtitles are saved into the project folder. Every
 * piece of text a post brings is written by other people: untrusted, never instructions. */

const TIMEOUT = 25_000, JSON_BYTES = 8_000_000;
/** yt-dlp, pinned: the version Agent-Reach 1.6.1 tests against. */
export const YT_DLP = 'yt-dlp==2026.8.19';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 ros.ai';
export type PostSort = 'relevance' | 'new' | 'top';
/** A post as read, before its photos and subtitles are saved: the subtitles' full text rides along. */
export type ReadPost = { post: Omit<PostView, 'subtitles'> & { subtitles?: Omit<NonNullable<PostView['subtitles']>, 'path' | 'text'> }; subtitles?: string };

const clean = (text: unknown, limit: number) => typeof text === 'string' ? text.replace(/\r\n?/gu, '\n').replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim().slice(0, limit) : '';
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
const iso = (seconds: unknown) => typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined;
const counts = (entries: Record<string, number | undefined>) => Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined)) as PostView['counts'];
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', '#39': '\'', '#x27': '\'', '#x2F': '/', nbsp: ' ' };
/** HTML from Hacker News and GitHub as plain text: paragraphs kept, links as their text, entities decoded. */
export function htmlText(html: unknown): string {
  if (typeof html !== 'string') return '';
  return html.replace(/<p>/giu, '\n\n').replace(/<br\s*\/?>/giu, '\n').replace(/<\/?(pre|code|i|b|em|strong)>/giu, '').replace(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/giu, (_all, href: string, text: string) => text || href)
    .replace(/<[^>]+>/gu, '').replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (all, name: string) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? (name.startsWith('#x') ? String.fromCodePoint(parseInt(name.slice(2), 16)) : name.startsWith('#') ? String.fromCodePoint(Number(name.slice(1))) : all));
}
/** WebVTT subtitles as running text: no cue times or tags, and no lines auto captions repeat as they roll on. */
export function subtitleText(vtt: string): string {
  const lines: string[] = [];
  for (const raw of vtt.replace(/\r/gu, '').split('\n')) {
    const line = raw.replace(/<[^>]+>/gu, '').replace(/&nbsp;/gu, ' ').replace(/&amp;/gu, '&').trim();
    if (!line || line === 'WEBVTT' || /^(Kind|Language|NOTE|STYLE|Region):?/u.test(line) || /-->/u.test(line) || /^\d+$/u.test(line)) continue;
    if (lines.at(-1) === line || lines.at(-2) === line) continue;
    lines.push(line);
  }
  return lines.join('\n');
}

type Options = { fetcher?: typeof fetch; python?: PythonRuntime; signedIn?: SignedInBrowser; githubToken?: () => string | undefined; ytDlp?: (args: string[], timeout: number) => Promise<string> };

export class Posts {
  private readonly fetcher: typeof fetch;
  private readonly ytDlpRun?: (args: string[], timeout: number) => Promise<string>;
  private installing?: Promise<string>;
  constructor(private readonly options: Options = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.ytDlpRun = options.ytDlp ?? (options.python ? (args, timeout) => this.runYtDlp(options.python!, args, timeout) : undefined);
  }

  /** Posts on one platform that match a query, newest or most liked first when asked. Nothing is saved. */
  async search(platform: PostPlatform, query: string, limit = 10, sort: PostSort = 'relevance', signal?: AbortSignal): Promise<PostHit[]> {
    const count = Math.max(1, Math.min(MAX_POST_HITS, limit));
    if (platform === 'xiaohongshu') return searchXiaohongshu(this.signedIn(), query, count, sort);
    if (platform === 'hackernews') {
      const body = await this.json(`https://hn.algolia.com/api/v1/${sort === 'new' ? 'search_by_date' : 'search'}?${new URLSearchParams({ query, tags: 'story', hitsPerPage: String(count) })}`, 'Hacker News', signal) as { hits?: Record<string, unknown>[] };
      const hits = (body.hits ?? []).map(hit => ({ platform, url: `https://news.ycombinator.com/item?id=${hit.objectID}`, title: clean(hit.title, 300) || 'Untitled', author: clean(hit.author, 100) || undefined, postedAt: typeof hit.created_at === 'string' ? hit.created_at : undefined, counts: counts({ points: num(hit.points), comments: num(hit.num_comments) }), snippet: clean(htmlText(hit.story_text) || (typeof hit.url === 'string' ? hit.url : ''), 300) || undefined } satisfies PostHit));
      return sort === 'top' ? hits.sort((a, b) => (b.counts.points ?? 0) - (a.counts.points ?? 0)) : hits;
    }
    if (platform === 'reddit') {
      const body = await this.json(`https://www.reddit.com/search.json?${new URLSearchParams({ q: query, limit: String(count), sort: sort === 'new' ? 'new' : sort === 'top' ? 'top' : 'relevance', t: 'all', raw_json: '1', type: 'link' })}`, 'Reddit', signal) as { data?: { children?: { data: Record<string, unknown> }[] } };
      return (body.data?.children ?? []).map(({ data }) => ({ platform, url: `https://www.reddit.com${data.permalink}`, title: clean(data.title, 300) || 'Untitled', author: clean(data.author, 100) || undefined, community: clean(data.subreddit_name_prefixed, 100) || undefined, postedAt: iso(data.created_utc), counts: counts({ points: num(data.score), comments: num(data.num_comments) }), snippet: clean(data.selftext, 300) || undefined, thumbnail: redditPhotos(data)[0] } satisfies PostHit));
    }
    if (platform === 'github') {
      const body = await this.github(`/search/repositories?${new URLSearchParams({ q: query, per_page: String(count), ...(sort === 'top' ? { sort: 'stars' } : sort === 'new' ? { sort: 'updated' } : {}) })}`, signal) as { items?: Record<string, unknown>[] };
      return (body.items ?? []).map(repo => ({ platform, url: String(repo.html_url), title: String(repo.full_name), author: clean((repo.owner as { login?: string } | undefined)?.login, 100) || undefined, postedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : undefined, counts: counts({ stars: num(repo.stargazers_count), forks: num(repo.forks_count) }), snippet: clean(repo.description, 300) || undefined } satisfies PostHit));
    }
    const out = await this.ytDlp([`${sort === 'new' ? 'ytsearchdate' : 'ytsearch'}${count}:${query}`, '--flat-playlist', '--dump-single-json', '--no-warnings'], 90_000);
    const entries = ((JSON.parse(out) as { entries?: Record<string, unknown>[] }).entries ?? []).filter(entry => typeof entry.id === 'string');
    const hits = entries.map(entry => ({ platform, url: `https://www.youtube.com/watch?v=${entry.id}`, title: clean(entry.title, 300) || 'Untitled', author: clean(entry.channel ?? entry.uploader, 100) || undefined, counts: counts({ views: num(entry.view_count) }), snippet: clean(entry.description, 300) || undefined, thumbnail: bestThumbnail(entry), duration: num(entry.duration) } satisfies PostHit));
    return sort === 'top' ? hits.sort((a, b) => (b.counts.views ?? 0) - (a.counts.views ?? 0)) : hits;
  }

  /** One post from its link, as its platform shows it now. */
  async read(link: string, signal?: AbortSignal): Promise<ReadPost> {
    const platform = postPlatform(link);
    if (!platform) throw new StoreError(`ros.ai reads posts from ${POST_PLATFORMS.map(id => POST_PLATFORM_NAMES[id]).join(', ')}; ${link.slice(0, 200)} is not a link to one of them.`);
    if (platform === 'xiaohongshu') return readXiaohongshu(this.signedIn(), link);
    if (platform === 'hackernews') return this.readHackerNews(link, signal);
    if (platform === 'reddit') return this.readReddit(link, signal);
    if (platform === 'github') return this.readGithub(link, signal);
    return this.readYoutube(link);
  }

  private signedIn(): SignedInBrowser {
    if (!this.options.signedIn) throw new StoreError('Xiaohongshu is read in ros.ai\'s signed-in browser, which this ros.ai does not run.', 501);
    return this.options.signedIn;
  }

  private async readHackerNews(link: string, signal?: AbortSignal): Promise<ReadPost> {
    const id = new URL(link).searchParams.get('id');
    if (!id || !/^\d{1,12}$/u.test(id)) throw new StoreError('A Hacker News link names its item: news.ycombinator.com/item?id=…');
    const item = await this.json(`https://hn.algolia.com/api/v1/items/${id}`, 'Hacker News', signal) as Record<string, unknown>;
    const comments: PostComment[] = [];
    const walk = (children: unknown, depth: number) => {
      for (const child of Array.isArray(children) ? children as Record<string, unknown>[] : []) {
        if (comments.length >= MAX_POST_COMMENTS) return;
        const text = clean(htmlText(child.text), POST_COMMENT_TEXT);
        if (text) comments.push({ author: clean(child.author, 200) || 'someone', text, ...(typeof child.created_at === 'string' ? { at: child.created_at } : {}), depth });
        if (depth < 2) walk(child.children, depth + 1);
      }
    };
    walk(item.children, 0);
    const outLink = typeof item.url === 'string' ? item.url : '';
    const text = clean(htmlText(item.text), POST_TEXT) || (outLink ? `Links to ${outLink}` : '');
    const all = (children: unknown): number => (Array.isArray(children) ? children as Record<string, unknown>[] : []).reduce((sum, child) => sum + 1 + all(child.children), 0);
    return { post: { platform: 'hackernews', shape: 'text', url: `https://news.ycombinator.com/item?id=${id}`, id, title: clean(item.title, 500) || undefined, text, author: { name: clean(item.author, 200) || 'someone', url: item.author ? `https://news.ycombinator.com/user?id=${encodeURIComponent(String(item.author))}` : undefined },
      community: 'Hacker News', postedAt: typeof item.created_at === 'string' ? item.created_at : undefined, counts: counts({ points: num(item.points), comments: all(item.children) }), photos: [], comments, readAt: new Date().toISOString() } };
  }

  private async readReddit(link: string, signal?: AbortSignal): Promise<ReadPost> {
    const url = new URL(link), host = url.hostname.toLowerCase();
    const id = host.endsWith('redd.it') ? url.pathname.split('/').filter(Boolean)[0] : url.pathname.match(/\/comments\/([a-z0-9]{2,12})/iu)?.[1];
    if (!id || !/^[a-z0-9]{2,12}$/iu.test(id)) throw new StoreError('A Reddit link to a post has /comments/<id>/ in it.');
    const body = await this.json(`https://www.reddit.com/comments/${id}.json?${new URLSearchParams({ raw_json: '1', limit: '40', sort: 'top', depth: '3' })}`, 'Reddit', signal) as { data?: { children?: { kind: string; data: Record<string, unknown> }[] } }[];
    const data = body[0]?.data?.children?.[0]?.data;
    if (!data) throw new StoreError('Reddit sent no post for that link.', 404);
    const comments: PostComment[] = [];
    const walk = (listing: unknown, depth: number) => {
      const children = (listing as { data?: { children?: { kind: string; data: Record<string, unknown> }[] } } | undefined)?.data?.children ?? [];
      for (const child of children) {
        if (comments.length >= MAX_POST_COMMENTS || child.kind !== 't1') continue;
        const text = clean(child.data.body, POST_COMMENT_TEXT);
        if (text && text !== '[deleted]' && text !== '[removed]') comments.push({ author: clean(child.data.author, 200) || 'someone', text, likes: num(child.data.score), at: iso(child.data.created_utc), depth });
        if (depth < 2) walk(child.data.replies, depth + 1);
      }
    };
    walk(body[1], 0);
    const photos = redditPhotos(data).slice(0, MAX_POST_PHOTOS).map(photo => ({ url: photo }));
    const video = Boolean(data.is_video);
    const outLink = typeof data.url_overridden_by_dest === 'string' && !/reddit\.com|redd\.it/iu.test(data.url_overridden_by_dest) ? data.url_overridden_by_dest : '';
    const text = clean(data.selftext, POST_TEXT) || (outLink ? `Links to ${outLink}` : '');
    return { post: { platform: 'reddit', shape: photos.length && !text ? 'photo' : video ? 'video' : 'text', url: `https://www.reddit.com${data.permalink ?? `/comments/${id}/`}`, id, title: clean(data.title, 500) || undefined, text,
      author: { name: clean(data.author, 200) || 'someone', ...(data.author && data.author !== '[deleted]' ? { url: `https://www.reddit.com/user/${encodeURIComponent(String(data.author))}` } : {}) },
      community: clean(data.subreddit_name_prefixed, 200) || undefined, postedAt: iso(data.created_utc), counts: counts({ points: num(data.score), comments: num(data.num_comments) }), photos,
      ...(typeof data.link_flair_text === 'string' && data.link_flair_text ? { tags: [clean(data.link_flair_text, 100)] } : {}), comments, readAt: new Date().toISOString() } };
  }

  private async readGithub(link: string, signal?: AbortSignal): Promise<ReadPost> {
    const parts = new URL(link).pathname.split('/').filter(Boolean);
    const [owner, repo, kind, number] = parts;
    if (!owner || !repo || !/^[A-Za-z0-9_.-]{1,100}$/u.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/u.test(repo)) throw new StoreError('A GitHub link names a repository (github.com/owner/name), an issue or a pull request.');
    const name = `${owner}/${repo.replace(/\.git$/u, '')}`, readAt = new Date().toISOString();
    if ((kind === 'issues' || kind === 'pull' || kind === 'discussions') && /^\d{1,9}$/u.test(number ?? '')) {
      if (kind === 'discussions') throw new StoreError('GitHub discussions are not read yet; give an issue, a pull request or the repository.');
      const issue = await this.github(`/repos/${name}/issues/${number}`, signal) as Record<string, unknown>;
      const thread = await this.github(`/repos/${name}/issues/${number}/comments?per_page=${MAX_POST_COMMENTS}`, signal) as Record<string, unknown>[];
      const comments = thread.map(comment => ({ author: clean((comment.user as { login?: string } | undefined)?.login, 200) || 'someone', text: clean(comment.body, POST_COMMENT_TEXT), at: typeof comment.created_at === 'string' ? comment.created_at : undefined, likes: num((comment.reactions as { '+1'?: number } | undefined)?.['+1']), depth: 0 })).filter(comment => comment.text);
      const user = (issue.user as { login?: string; html_url?: string } | undefined);
      const labels = (Array.isArray(issue.labels) ? issue.labels as { name?: string }[] : []).map(label => clean(label.name, 100)).filter(Boolean).slice(0, 30);
      return { post: { platform: 'github', shape: 'text', url: String(issue.html_url ?? link), id: `${name}#${number}`, title: clean(issue.title, 500) || undefined, text: clean(issue.body, POST_TEXT), author: { name: clean(user?.login, 200) || 'someone', ...(user?.html_url ? { url: user.html_url } : {}) },
        community: `${name} · ${issue.pull_request ? 'pull request' : 'issue'} #${number} · ${issue.state === 'closed' ? 'closed' : 'open'}`, postedAt: typeof issue.created_at === 'string' ? issue.created_at : undefined, counts: counts({ comments: num(issue.comments), likes: num((issue.reactions as { '+1'?: number } | undefined)?.['+1']) }), photos: [], ...(labels.length ? { tags: labels } : {}), comments, readAt } };
    }
    const info = await this.github(`/repos/${name}`, signal) as Record<string, unknown>;
    let readme = '';
    try { readme = await this.githubText(`/repos/${name}/readme`, signal); } catch { /* a repository without a README */ }
    const owner_ = info.owner as { login?: string; html_url?: string } | undefined, topics = (Array.isArray(info.topics) ? info.topics as string[] : []).slice(0, 30);
    const text = clean([clean(info.description, 1000), readme].filter(Boolean).join('\n\n'), POST_TEXT);
    return { post: { platform: 'github', shape: 'text', url: String(info.html_url ?? `https://github.com/${name}`), id: String(info.full_name ?? name), title: String(info.full_name ?? name), text, author: { name: clean(owner_?.login, 200) || owner, ...(owner_?.html_url ? { url: owner_.html_url } : {}) },
      community: [typeof info.language === 'string' ? info.language : '', typeof (info.license as { spdx_id?: string } | null)?.spdx_id === 'string' ? (info.license as { spdx_id: string }).spdx_id : ''].filter(Boolean).join(' · ') || undefined,
      postedAt: typeof info.pushed_at === 'string' ? info.pushed_at : undefined, counts: counts({ stars: num(info.stargazers_count), forks: num(info.forks_count) }), photos: [], ...(topics.length ? { tags: topics } : {}), readAt } };
  }

  private async readYoutube(link: string): Promise<ReadPost> {
    const video = youtubeVideo(link);
    if (!video) throw new StoreError('That YouTube link is a playlist, a channel or a search, not one video. Open the video and copy its link.');
    const out = await this.ytDlp(['--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings', '--write-comments', '--extractor-args', `youtube:max_comments=${MAX_POST_COMMENTS},all,0;comment_sort=top`, `https://www.youtube.com/watch?v=${video}`], 120_000);
    const info = JSON.parse(out) as Record<string, unknown>;
    if (typeof info.id !== 'string') throw new StoreError('YouTube sent no video for that link.', 404);
    const comments = (Array.isArray(info.comments) ? info.comments as Record<string, unknown>[] : []).filter(comment => comment.parent === 'root' || comment.parent === undefined).slice(0, MAX_POST_COMMENTS)
      .map(comment => ({ author: clean(comment.author, 200).replace(/^@/u, '') || 'someone', text: clean(comment.text, POST_COMMENT_TEXT), likes: num(comment.like_count), at: iso(comment.timestamp), depth: 0 })).filter(comment => comment.text);
    const date = typeof info.upload_date === 'string' && /^\d{8}$/u.test(info.upload_date) ? `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6)}` : undefined;
    const thumbnail = bestThumbnail(info), live = info.live_status === 'is_live';
    const picked = pickSubtitles(info);
    let subtitles: string | undefined;
    if (picked) try { subtitles = await this.subtitles(info.id, picked); } catch { /* the video stays without its subtitles */ }
    const tags = (Array.isArray(info.tags) ? info.tags as string[] : []).map(tag => clean(tag, 100)).filter(Boolean).slice(0, 30);
    return { post: { platform: 'youtube', shape: 'video', url: `https://www.youtube.com/watch?v=${info.id}`, id: info.id, title: clean(info.title, 500) || undefined, text: clean(info.description, POST_TEXT),
      author: { name: clean(info.channel ?? info.uploader, 200) || 'someone', ...(typeof (info.channel_url ?? info.uploader_url) === 'string' ? { url: String(info.channel_url ?? info.uploader_url) } : {}) },
      community: clean(info.channel ?? info.uploader, 200) || undefined, ...(date ? { postedAt: date } : {}), counts: counts({ views: num(info.view_count), likes: num(info.like_count), comments: num(info.comment_count) }),
      photos: thumbnail ? [{ url: thumbnail }] : [], ...(tags.length ? { tags } : {}), comments, ...(num(info.duration) !== undefined ? { duration: num(info.duration) } : {}),
      ...(picked && subtitles ? { subtitles: { language: picked.language, automatic: picked.automatic, characters: subtitles.length } } : {}),
      ...(live ? { notice: 'This video was live when it was read.' } : picked && !subtitles ? { notice: 'Its subtitles could not be read.' } : !picked ? { notice: 'This video has no subtitles.' } : {}),
      readAt: new Date().toISOString() }, ...(subtitles ? { subtitles } : {}) };
  }

  /** One video's subtitles in the language picked, as running text. */
  private async subtitles(id: string, picked: { language: string; automatic: boolean }): Promise<string> {
    const folder = mkdtempSync(join(tmpdir(), 'ros-subtitles-'));
    try {
      await this.ytDlp(['--skip-download', '--no-playlist', '--no-warnings', picked.automatic ? '--write-auto-subs' : '--write-subs', '--sub-langs', picked.language, '--sub-format', 'vtt', '-o', join(folder, 'video'), `https://www.youtube.com/watch?v=${id}`], 90_000);
      const file = readdirSync(folder).find(name => name.endsWith('.vtt'));
      if (!file) throw new Error('no subtitles file');
      return subtitleText(readFileSync(join(folder, file), 'utf8'));
    } finally { rmSync(folder, { recursive: true, force: true }); }
  }

  /** yt-dlp from ros.ai's own Python, installed into its data folder the first time a YouTube post is read. */
  private async ytDlp(args: string[], timeout: number): Promise<string> {
    if (!this.ytDlpRun) throw new StoreError('YouTube posts are read only in the local app.', 403);
    try { return await this.ytDlpRun(args, timeout); }
    catch (error) {
      if (error instanceof StoreError) throw error;
      const text = error instanceof Error ? error.message : String(error), last = text.split('\n').map(line => line.trim()).filter(line => /ERROR/u.test(line)).at(-1) ?? text.split('\n').at(-1) ?? text;
      if (/Sign in to confirm|not a bot/iu.test(text)) throw new StoreError('YouTube asked to confirm this is not a bot, so it was not read. Try again later.', 429);
      if (/Video unavailable|Private video|removed/iu.test(text)) throw new StoreError('YouTube says this video is unavailable.', 404);
      throw new StoreError(`YouTube could not be read: ${last.replace(/^ERROR:\s*/u, '').slice(0, 300)}`, 502);
    }
  }
  private async runYtDlp(python: PythonRuntime, args: string[], timeout: number): Promise<string> {
    const target = await this.installYtDlp(python);
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? tmpdir(), LANG: 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8',
      ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}), ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}) };
    // -I keeps the person's own Python settings out; yt-dlp is imported from its own folder.
    const launcher = `import sys; sys.path.insert(0, ${JSON.stringify(target)}); import yt_dlp; sys.argv[0] = 'yt-dlp'; yt_dlp.main()`;
    return await new Promise<string>((resolve, reject) => execFile(python.python, ['-I', '-c', launcher, '--ignore-config', '--no-cache-dir', ...args], { env, timeout, maxBuffer: 50_000_000 },
      (error, stdout, stderr) => error ? reject(new Error(`${stderr || error.message}`.slice(-2000))) : resolve(stdout)));
  }
  private installYtDlp(python: PythonRuntime): Promise<string> {
    const target = join(python.home, 'tools', YT_DLP.replace(/[^A-Za-z0-9.]+/gu, '-'));
    if (existsSync(join(target, '.ready'))) return Promise.resolve(target);
    this.installing ??= (async () => {
      const interpreter = await python.ensure();
      const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? tmpdir(), PIP_DISABLE_PIP_VERSION_CHECK: '1',
        ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}), ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}) };
      rmSync(target, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) => execFile(interpreter, ['-I', '-m', 'pip', 'install', '--quiet', '--no-input', '--target', target, YT_DLP], { env, timeout: 300_000, maxBuffer: 20_000_000 },
        (error, _stdout, stderr) => error ? reject(new StoreError(`yt-dlp, which reads YouTube, could not be installed: ${(stderr || error.message).trim().split('\n').at(-1)?.slice(0, 300)}`, 502)) : resolve()));
      writeFileSync(join(target, '.ready'), YT_DLP);
      return target;
    })().finally(() => { this.installing = undefined; });
    return this.installing;
  }

  private async json(url: string, platform: string, signal?: AbortSignal, headers: Record<string, string> = {}): Promise<unknown> {
    const response = await this.fetcher(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT) })
      .catch((error: unknown) => { throw new StoreError(`${platform} did not answer${error instanceof Error && error.name === 'TimeoutError' ? ' in time' : ''}.`, 502); });
    if (response.status === 404) { await response.body?.cancel().catch(() => undefined); throw new StoreError(`${platform} has no such post.`, 404); }
    if (response.status === 429) { await response.body?.cancel().catch(() => undefined); throw new StoreError(`${platform} asked ros.ai to slow down. Try again in a minute.`, 429); }
    if (response.status === 401 || response.status === 403) { await response.body?.cancel().catch(() => undefined); throw new StoreError(platform === 'Reddit' ? 'Reddit refused to answer without a login (HTTP 403). Find Reddit threads with a web search instead, and add them by link later, once ros.ai can sign in to Reddit.' : `${platform} refused the request (HTTP ${response.status}).`, 403); }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new StoreError(`${platform} answered HTTP ${response.status}.`, 502); }
    try { return JSON.parse((await readLimited(response, JSON_BYTES)).toString('utf8')); }
    catch { throw new StoreError(`${platform} sent something ros.ai could not read.`, 502); }
  }
  private githubHeaders(accept = 'application/vnd.github+json'): Record<string, string> {
    const token = this.options.githubToken?.();
    return { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }
  private github(path: string, signal?: AbortSignal) { return this.json(`https://api.github.com${path}`, 'GitHub', signal, this.githubHeaders()); }
  private async githubText(path: string, signal?: AbortSignal): Promise<string> {
    const response = await this.fetcher(`https://api.github.com${path}`, { headers: { 'User-Agent': UA, ...this.githubHeaders('application/vnd.github.raw+json') }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT) });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(`HTTP ${response.status}`); }
    return clean((await readLimited(response, 1_000_000)).toString('utf8'), POST_TEXT);
  }
}

/** The pictures of a Reddit post: a gallery's, or the preview of an image post, largest first. */
function redditPhotos(data: Record<string, unknown>): string[] {
  const gallery = data.media_metadata as Record<string, { s?: { u?: string; gif?: string } }> | undefined, order = (data.gallery_data as { items?: { media_id: string }[] } | undefined)?.items;
  if (gallery && order?.length) return order.map(item => gallery[item.media_id]?.s?.u ?? gallery[item.media_id]?.s?.gif).filter((url): url is string => typeof url === 'string' && url.startsWith('https://'));
  const preview = (data.preview as { images?: { source?: { url?: string } }[] } | undefined)?.images?.[0]?.source?.url;
  if (preview?.startsWith('https://')) return [preview];
  return typeof data.url_overridden_by_dest === 'string' && /^https:\/\/i\.redd\.it\/.+\.(jpe?g|png|webp|gif)$/iu.test(data.url_overridden_by_dest) ? [data.url_overridden_by_dest] : [];
}
/** A video's largest JPEG or WebP thumbnail. */
function bestThumbnail(info: Record<string, unknown>): string | undefined {
  const list = (Array.isArray(info.thumbnails) ? info.thumbnails as { url?: string; width?: number; preference?: number }[] : []).filter(item => typeof item.url === 'string' && /^https:\/\//u.test(item.url) && !/\.avif(\?|$)/u.test(item.url!));
  const best = list.sort((a, b) => (b.width ?? 0) - (a.width ?? 0) || (b.preference ?? 0) - (a.preference ?? 0))[0]?.url;
  return best ?? (typeof info.thumbnail === 'string' ? info.thumbnail : undefined);
}
/** Which subtitles to read: the video's own in its language, then any it has, then automatic ones in its language, then English. */
export function pickSubtitles(info: Record<string, unknown>): { language: string; automatic: boolean } | undefined {
  const own = Object.keys((info.subtitles ?? {}) as object).filter(language => language !== 'live_chat'), auto = Object.keys((info.automatic_captions ?? {}) as object);
  const spoken = typeof info.language === 'string' ? info.language : undefined, base = (language: string) => language.split('-')[0].toLowerCase();
  const match = (list: string[], language?: string) => language ? list.find(item => item === language) ?? list.find(item => base(item) === base(language)) : undefined;
  const ownPick = match(own, spoken) ?? match(own, 'en') ?? own[0];
  if (ownPick) return { language: ownPick, automatic: false };
  const autoPick = (spoken ? auto.find(item => item === `${spoken}-orig`) ?? match(auto, spoken) : undefined) ?? auto.find(item => item.endsWith('-orig')) ?? match(auto, 'en');
  return autoPick ? { language: autoPick, automatic: true } : undefined;
}

/** Saves a read post's photos and subtitles into posts/<title>/ in the project folder and returns the post as a block
 * keeps it. Without a folder the photos stay links (not shown) and the subtitles are kept, shortened, in the block. */
export async function keepPost(read: ReadPost, projectId: string, title: string, tools: { folders?: ProjectFolders; files?: WebFileFetcher }, signal?: AbortSignal): Promise<{ post: PostView; problems: string[] }> {
  const { subtitles: subtitleInfo, ...rest } = read.post, problems: string[] = [];
  const folder = tools.folders?.status(projectId);
  if (!tools.folders || !folder?.attached || folder.available === false) {
    if (read.post.photos.length) problems.push('The project has no folder, so the post\'s photos were not saved.');
    return { post: { ...rest, ...(subtitleInfo && read.subtitles ? { subtitles: { ...subtitleInfo, text: read.subtitles.slice(0, POST_SUBTITLES_KEPT) } } : {}) }, problems };
  }
  if (!read.post.photos.length && !(subtitleInfo && read.subtitles)) return { post: rest, problems };
  const place = tools.folders.postFolder(projectId, title);
  const photos = await Promise.all(read.post.photos.slice(0, MAX_POST_PHOTOS).map(async (photo, index) => {
    if (!tools.files) return photo;
    try {
      const file = await tools.files.file(photo.url, signal);
      if (file.extension === '.pdf') throw new Error('it is a PDF');
      const path = `${place}/${index + 1}${file.extension}`;
      tools.folders!.savePostFile(projectId, path, file.bytes);
      return { ...photo, path };
    } catch (error) { problems.push(`Photo ${index + 1} was not saved: ${error instanceof Error ? error.message.slice(0, 160) : 'it did not download'}.`); return photo; }
  }));
  let subtitles: PostView['subtitles'];
  if (subtitleInfo && read.subtitles) {
    const path = `${place}/subtitles.txt`;
    try { tools.folders.savePostFile(projectId, path, Buffer.from(read.subtitles, 'utf8')); subtitles = { ...subtitleInfo, path }; }
    catch { subtitles = { ...subtitleInfo, text: read.subtitles.slice(0, POST_SUBTITLES_KEPT) }; }
  }
  return { post: { ...rest, photos, ...(subtitles ? { subtitles } : {}) }, problems };
}

/** The video a YouTube link names (watch?v=, youtu.be/, shorts/, live/, embed/), or undefined for a playlist, a
 * channel or a search, which are not one post. */
export function youtubeVideo(link: string): string | undefined {
  let url: URL;
  try { url = new URL(link); } catch { return undefined; }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./u, ''), [first, second] = url.pathname.split('/').filter(Boolean);
  const id = host === 'youtu.be' ? first : first === 'watch' ? url.searchParams.get('v') ?? undefined : ['shorts', 'live', 'embed', 'v'].includes(first ?? '') ? second : undefined;
  return id && /^[\w-]{1,64}$/u.test(id) ? id : undefined;
}

/** The title a Post block gets: the post's own title, or the start of its text. */
export function postTitle(post: Pick<PostView, 'title' | 'text' | 'author' | 'platform'>): string {
  const first = post.title?.trim() || post.text.split('\n').map(line => line.trim()).find(Boolean) || `${POST_PLATFORM_NAMES[post.platform]} post by ${post.author.name}`;
  return first.length > 120 ? `${first.slice(0, 117).trimEnd()}…` : first;
}

/** A post's subtitles text, from the project folder or the block. */
export function postSubtitles(post: PostView, projectId: string, folders: ProjectFolders | undefined, limit: number): string | undefined {
  if (post.subtitles?.text !== undefined) return post.subtitles.text.slice(0, limit);
  if (post.subtitles?.path && folders) try { return folders.postText(projectId, post.subtitles.path, limit); } catch { return undefined; }
  return undefined;
}

export function attachPostRoutes(app: Express, store: Store, posts: Posts, tools: { folders?: ProjectFolders; files?: WebFileFetcher }) {
  // Reads a post from its link for Add block › Post, saving its photos and subtitles into the project folder first.
  app.post('/api/projects/:id/posts/read', async (req, res) => {
    const projectId = z.string().min(1).max(128).parse(req.params.id), { url } = z.object({ url: z.string().trim().url().max(2000) }).strict().parse(req.body);
    store.getProject(projectId);
    const read = await posts.read(url), title = postTitle(read.post);
    const kept = await keepPost(read, projectId, title, tools);
    res.json({ title, ...kept });
  });
  // The subtitles a Post block keeps, for its opened view.
  app.get('/api/projects/:id/nodes/:nodeId/post-subtitles', (req, res) => {
    const projectId = String(req.params.id), node = store.getProject(projectId).canvas.nodes.find(item => item.id === String(req.params.nodeId));
    if (!node?.post?.subtitles) throw new StoreError('This post has no subtitles.', 404);
    const text = postSubtitles(node.post, projectId, tools.folders, 2_000_000);
    if (text === undefined) throw new StoreError('Its subtitles are missing from the project folder.', 404);
    res.json({ text });
  });
}
