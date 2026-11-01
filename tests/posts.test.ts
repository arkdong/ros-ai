import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import type { ExecutionService } from '../src/server/execution.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { AgentWorkspaceTools } from '../src/server/agent-tools.js';
import { Posts, htmlText, keepPost, pickSubtitles, postTitle, subtitleText } from '../src/server/posts.js';
import { duration, postPlatform, shortCount } from '../src/shared/posts.js';
import { kindName } from '../src/shared/vocabulary.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Stand-ins for Hacker News (Algolia), Reddit and GitHub, as their public JSON answers.
const fetcher = (async (input: string | URL) => {
  const url = String(input);
  if (url.startsWith('https://hn.algolia.com/api/v1/search?')) return json({ hits: [{ objectID: '41', title: 'Show HN: A canvas for agents', author: 'adam', points: 120, num_comments: 2, created_at: '2026-10-30T10:00:00Z', url: 'https://ros-ai.io' }] });
  if (url === 'https://hn.algolia.com/api/v1/items/41') return json({ id: 41, title: 'Show HN: A canvas for agents', author: 'adam', points: 120, url: 'https://ros-ai.io', created_at: '2026-10-30T10:00:00Z', text: null,
    children: [{ author: 'pg', text: '<p>Nice &amp; simple. See <a href="https://x.org">x.org</a></p>', created_at: '2026-10-30T11:00:00Z', children: [{ author: 'dang', text: 'Agreed', children: [] }] }] });
  if (url.startsWith('https://www.reddit.com/comments/abc123.json')) return json([
    { data: { children: [{ kind: 't3', data: { id: 'abc123', title: 'Best hotpot in Amsterdam?', selftext: 'Looking for spicy broth.', author: 'lily', subreddit_name_prefixed: 'r/Amsterdam', score: 64, num_comments: 12, created_utc: 1761800000, permalink: '/r/Amsterdam/comments/abc123/best_hotpot/',
      preview: { images: [{ source: { url: 'https://i.redd.it/photo.jpg' } }] } } }] } },
    { data: { children: [{ kind: 't1', data: { author: 'tom', body: 'Go to the one on Zeedijk.', score: 30, created_utc: 1761800100, replies: { data: { children: [{ kind: 't1', data: { author: 'mia', body: 'Too salty.', score: 4 } }] } } } }, { kind: 't1', data: { author: 'x', body: '[deleted]' } }, { kind: 'more', data: {} }] } },
  ]);
  if (url.startsWith('https://www.reddit.com/search.json')) return json({}, 403);
  if (url === 'https://api.github.com/repos/arkdong/ros-ai') return json({ full_name: 'arkdong/ros-ai', html_url: 'https://github.com/arkdong/ros-ai', description: 'The open workspace', stargazers_count: 12, forks_count: 1, language: 'TypeScript', license: { spdx_id: 'MIT' }, owner: { login: 'arkdong', html_url: 'https://github.com/arkdong' }, topics: ['agents'], pushed_at: '2026-11-01T00:00:00Z' });
  if (url === 'https://api.github.com/repos/arkdong/ros-ai/readme') return new Response('# ros.ai\n\nRun your agents in the open.', { status: 200 });
  if (url === 'https://api.github.com/repos/arkdong/ros-ai/issues/7') return json({ html_url: 'https://github.com/arkdong/ros-ai/issues/7', title: 'Add posts', body: 'Xiaohongshu please', state: 'open', comments: 1, user: { login: 'adam' }, labels: [{ name: 'idea' }], created_at: '2026-11-01T00:00:00Z' });
  if (url.startsWith('https://api.github.com/repos/arkdong/ros-ai/issues/7/comments')) return json([{ user: { login: 'claude' }, body: 'On it.', created_at: '2026-11-01T01:00:00Z' }]);
  return json({}, 404);
}) as typeof fetch;

// A stand-in yt-dlp: a search, a video's details with comments, and its automatic English subtitles.
const VTT = 'WEBVTT\nKind: captions\nLanguage: en\n\n00:00:00.000 --> 00:00:02.000\nhello <c>everyone</c>\n\n00:00:01.000 --> 00:00:03.000\nhello everyone\nthis is hotpot\n\n00:00:03.000 --> 00:00:05.000\nthis is hotpot\n';
const ytDlp = async (args: string[]) => {
  if (args[0].startsWith('ytsearch')) return JSON.stringify({ entries: [{ id: 'vid1', title: 'Amsterdam hotpot tour', channel: 'Eats', view_count: 86000, duration: 848 }, { id: 'vid2', title: 'Second', view_count: 900000 }] });
  if (args.includes('--dump-single-json')) return JSON.stringify({ id: 'vid1', title: 'Amsterdam hotpot tour', description: 'Five places.', channel: 'Eats', channel_url: 'https://www.youtube.com/@eats', upload_date: '20261012', view_count: 86000, like_count: 2100, comment_count: 3, duration: 848, language: 'en',
    thumbnails: [{ url: 'https://i.ytimg.com/vi/vid1/hq.jpg', width: 480 }, { url: 'https://i.ytimg.com/vi/vid1/max.jpg', width: 1280 }], automatic_captions: { 'en-orig': [], nl: [] }, subtitles: { live_chat: [] },
    comments: [{ author: '@sam', text: 'Great tour', like_count: 5, parent: 'root' }, { author: '@lee', text: 'reply', parent: 'abc' }] });
  const output = args[args.indexOf('-o') + 1];
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${output}.en-orig.vtt`, VTT);
  return '';
};

test('Links name their platform; counts and lengths read as the platforms show them', () => {
  assert.equal(postPlatform('https://youtu.be/abc'), 'youtube');
  assert.equal(postPlatform('https://m.youtube.com/watch?v=abc'), 'youtube');
  assert.equal(postPlatform('https://old.reddit.com/r/a/comments/x1/y'), 'reddit');
  assert.equal(postPlatform('https://news.ycombinator.com/item?id=1'), 'hackernews');
  assert.equal(postPlatform('https://github.com/arkdong/ros-ai'), 'github');
  assert.equal(postPlatform('https://www.xiaohongshu.com/explore/1'), undefined);
  assert.equal(postPlatform('file:///etc/passwd'), undefined);
  assert.deepEqual([shortCount(1204), shortCount(31_000), shortCount(2_400_000)], ['1,204', '31k', '2.4M']);
  assert.deepEqual([duration(848), duration(3725)], ['14:08', '1:02:05']);
  assert.equal(kindName({ blockType: 'post', post: { platform: 'youtube' } }), 'YouTube');
  assert.equal(subtitleText(VTT), 'hello everyone\nthis is hotpot');
  assert.equal(htmlText('<p>a &amp; b<p><a href="https://x.org">x</a>'), '\n\na & b\n\nx');
  assert.deepEqual(pickSubtitles({ language: 'zh-Hans', subtitles: { en: [], 'zh-Hans': [] } }), { language: 'zh-Hans', automatic: false });
  assert.deepEqual(pickSubtitles({ language: 'nl', automatic_captions: { 'nl-orig': [], en: [] } }), { language: 'nl-orig', automatic: true });
  assert.equal(pickSubtitles({ subtitles: { live_chat: [] } }), undefined);
});

test('Posts are read from Hacker News, Reddit, GitHub and YouTube as each platform shows them', async () => {
  const posts = new Posts({ fetcher, ytDlp });
  const hn = await posts.read('https://news.ycombinator.com/item?id=41');
  assert.equal(hn.post.title, 'Show HN: A canvas for agents');
  assert.equal(hn.post.text, 'Links to https://ros-ai.io');
  assert.deepEqual(hn.post.counts, { points: 120, comments: 2 });
  assert.deepEqual(hn.post.comments?.map(comment => [comment.author, comment.text, comment.depth]), [['pg', 'Nice & simple. See x.org', 0], ['dang', 'Agreed', 1]]);

  const reddit = await posts.read('https://www.reddit.com/r/Amsterdam/comments/abc123/best_hotpot/');
  assert.equal(reddit.post.community, 'r/Amsterdam');
  assert.equal(reddit.post.shape, 'text');
  assert.deepEqual(reddit.post.photos, [{ url: 'https://i.redd.it/photo.jpg' }]);
  assert.deepEqual(reddit.post.comments?.map(comment => [comment.author, comment.depth]), [['tom', 0], ['mia', 1]]);
  await assert.rejects(posts.search('reddit', 'hotpot'), /Reddit refused to answer without a login/u);

  const repo = await posts.read('https://github.com/arkdong/ros-ai');
  assert.equal(repo.post.title, 'arkdong/ros-ai');
  assert.match(repo.post.text, /^The open workspace\n\n# ros\.ai/u);
  assert.equal(repo.post.community, 'TypeScript · MIT');
  const issue = await posts.read('https://github.com/arkdong/ros-ai/issues/7');
  assert.equal(issue.post.community, 'arkdong/ros-ai · issue #7 · open');
  assert.deepEqual(issue.post.tags, ['idea']);

  const video = await posts.read('https://youtu.be/vid1');
  assert.equal(video.post.shape, 'video');
  assert.equal(video.post.postedAt, '2026-10-12');
  assert.deepEqual(video.post.photos, [{ url: 'https://i.ytimg.com/vi/vid1/max.jpg' }]);
  assert.deepEqual(video.post.comments?.map(comment => comment.author), ['sam']);
  assert.deepEqual(video.post.subtitles, { language: 'en-orig', automatic: true, characters: 29 });
  assert.equal(video.subtitles, 'hello everyone\nthis is hotpot');
  assert.deepEqual((await posts.search('youtube', 'hotpot', 5, 'top')).map(hit => hit.title), ['Second', 'Amsterdam hotpot tour']);
  assert.equal((await posts.search('hackernews', 'canvas'))[0].url, 'https://news.ycombinator.com/item?id=41');
  await assert.rejects(posts.read('https://example.com/post'), /is not a link to one of them/u);
  // Without its own Python, ros.ai says YouTube cannot be read here.
  await assert.rejects(new Posts({ fetcher }).read('https://youtu.be/vid1'), /only in the local app/u);

  // Without a project folder the subtitles stay in the block, shortened, and the photos stay links.
  const kept = await keepPost(video, 'project', postTitle(video.post), {});
  assert.equal(kept.post.subtitles?.text, 'hello everyone\nthis is hotpot');
  assert.match(kept.problems[0], /no folder/u);
});

test('Agents search posts and add the ones they pick as Post blocks in one group', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-posts-')), store = new Store(join(dir, 'store'));
  const before = AgentWorkspaceTools.posts;
  AgentWorkspaceTools.posts = new Posts({ fetcher, ytDlp });
  const toolkit = (projectId: string) => new AgentWorkspaceTools(store, { searchService: () => ({ id: 'tavily' }), assistantProposal: (id: string, summary: string, operations: Parameters<Store['createProposal']>[3]) => store.createProposal(id, store.getProject(id).revision, summary, operations) } as unknown as ExecutionService, { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService, { projectId, nodeIds: [], artifactIds: [] }, 'turn-posts', 'claude');
  try {
    const project = store.createProject('Hotpot');
    assert(toolkit(project.id).definitions.some(tool => tool.name === 'ros_add_posts'));
    const found = await toolkit(project.id).call('ros_search_posts', { platform: 'reddit', query: 'hotpot amsterdam' }) as { results: unknown[]; problem?: string; instruction: string };
    assert.equal(found.results.length, 0);
    assert.match(found.instruction, /site:reddit\.com/u);

    type Added = { action: { proposalId: string }; committed: boolean; groupId?: string; added: { nodeId: string; title: string; platform: string }[]; notAdded?: { link: string; problem: string }[]; alreadyOnCanvas?: { title: string }[] };
    const added = await toolkit(project.id).call('ros_add_posts', { summary: 'Real posts about hotpot', rationale: 'The person wants real reviews.', group: 'Posts · Amsterdam hotpot',
      links: ['https://www.reddit.com/r/Amsterdam/comments/abc123/best_hotpot/', 'https://youtu.be/vid1', 'https://news.ycombinator.com/item?id=999', 'https://www.xiaohongshu.com/explore/1'] }) as Added;
    assert.equal(added.committed, false);
    assert.deepEqual(added.added.map(item => [item.title, item.platform]), [['Best hotpot in Amsterdam?', 'Reddit'], ['Amsterdam hotpot tour', 'YouTube']]);
    assert.deepEqual(added.notAdded?.map(item => item.problem.slice(0, 20)), ['Not a link to YouTub', 'Hacker News has no s']);
    store.acceptProposal(project.id, added.action.proposalId);
    const canvas = store.getProject(project.id).canvas, group = canvas.nodes.find(node => node.id === added.groupId)!;
    assert.equal(group.title, 'Posts · Amsterdam hotpot');
    const blocks = canvas.nodes.filter(node => node.blockType === 'post');
    assert.deepEqual(blocks.map(node => [node.parentId, node.post?.platform, node.width]), [[group.id, 'reddit', 320], [group.id, 'youtube', 320]]);
    assert.notEqual(blocks[0].x, blocks[1].x);

    // ros_read_canvas gives the post with its comments and the video's subtitles.
    const read = await toolkit(project.id).call('ros_read_canvas', { nodeIds: blocks.map(node => node.id) }) as { blocks: { post?: { comments?: unknown[]; subtitles?: string; author: string } }[] };
    assert.equal(read.blocks[0].post?.author, 'lily');
    assert.equal(read.blocks[0].post?.comments?.length, 2);
    assert.equal(read.blocks[1].post?.subtitles, 'hello everyone\nthis is hotpot');

    // The same post is not added twice.
    const again = await toolkit(project.id).call('ros_add_posts', { summary: 'Again', rationale: 'Twice.', links: ['https://old.reddit.com/r/Amsterdam/comments/abc123/'] }) as Added;
    assert.deepEqual(again.alreadyOnCanvas?.map(item => item.title), ['Best hotpot in Amsterdam?']);
    assert.equal(again.action, undefined);
  } finally {
    AgentWorkspaceTools.posts = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
