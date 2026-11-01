import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Route } from 'playwright-core';
import { BrowserService } from '../src/server/browser.js';
import { Posts } from '../src/server/posts.js';
import { SignedInBrowser } from '../src/server/signed-in-browser.js';
import type { Store } from '../src/server/store.js';
import { noteId, noteLink, notePost, noteText, searchHits } from '../src/server/xiaohongshu.js';
import { chineseCount, postCounts, postPlatform } from '../src/shared/posts.js';
import { kindName } from '../src/shared/vocabulary.js';

const ENGINE = new BrowserService(null as unknown as Store, tmpdir()).engine();
const NOTE = '6720a1b2c3d4e5f600000001';

test('Xiaohongshu links, counts, topic markup, search results and a note read as Post blocks keep them', () => {
  assert.equal(postPlatform(`https://www.xiaohongshu.com/explore/${NOTE}?xsec_token=abc`), 'xiaohongshu');
  assert.equal(postPlatform('http://xhslink.com/a/Ab12Cd'), 'xiaohongshu');
  assert.equal(kindName({ kind: 'topic', blockType: 'post', post: { platform: 'xiaohongshu' } }), 'Xiaohongshu');
  assert.deepEqual([chineseCount('1.2万'), chineseCount('10+'), chineseCount('3,456'), chineseCount('2千'), chineseCount(''), chineseCount('赞'), chineseCount(88)], [12_000, 10, 3456, 2000, undefined, undefined, 88]);
  assert.equal(noteText('排队一小时 #火锅[话题]# #阿姆斯特丹[地点]# 太好吃了[哭惹R]'), '排队一小时 #火锅 #阿姆斯特丹 太好吃了[哭惹]');
  assert.deepEqual([noteId(`https://www.xiaohongshu.com/explore/${NOTE}`), noteId(`https://www.xiaohongshu.com/discovery/item/${NOTE}?a=1`), noteId('https://www.xiaohongshu.com/explore')], [NOTE, NOTE, undefined]);
  assert.equal(noteLink(NOTE, 't=1'), `https://www.xiaohongshu.com/explore/${NOTE}?xsec_token=t%3D1&xsec_source=pc_search`);

  const hits = searchHits([
    { id: 'a', xsec_token: 'ta', model_type: 'note', note_card: { display_title: '阿姆斯特丹火锅', type: 'normal', user: { nickname: '小林' }, interact_info: { liked_count: '856' }, cover: { url_default: 'http://sns-webpic-qc.xhscdn.com/a.jpg' } } },
    { id: 'b', xsec_token: 'tb', model_type: 'note', note_card: { display_title: '最好吃的川菜', type: 'video', user: { nickname: 'Mia' }, interact_info: { liked_count: '1.1万' } } },
    { id: 'q', model_type: 'hot_query' }, { id: 'a', model_type: 'note', note_card: { display_title: 'again' } },
  ], 10, 'top');
  assert.deepEqual(hits.map(hit => [hit.title, hit.counts.likes, hit.url.includes('xsec_token=t'), hit.thumbnail ?? null, hit.snippet ?? null]), [['最好吃的川菜', 11_000, true, null, 'Video note'], ['阿姆斯特丹火锅', 856, true, 'https://sns-webpic-qc.xhscdn.com/a.jpg', null]]);

  const read = notePost({ noteId: NOTE, type: 'normal', title: '阿姆斯特丹最好吃的火锅', desc: '汤底很香 #火锅[话题]#', time: 1761800000000, ipLocation: '荷兰', user: { nickname: '小林', userId: 'u1' }, interactInfo: { likedCount: '1.2万', collectedCount: '3000', commentCount: '210' },
    imageList: [{ urlDefault: 'http://sns-webpic-qc.xhscdn.com/1.jpg', width: 1080, height: 1440 }, { infoList: [{ imageScene: 'WB_DFT', url: 'https://sns-webpic-qc.xhscdn.com/2.jpg' }] }], tagList: [{ name: '火锅' }, { name: '阿姆斯特丹美食' }] },
  `https://www.xiaohongshu.com/explore/${NOTE}?xsec_token=tok`, [{ content: '求地址', like_count: '12', create_time: 1761800100000, user_info: { nickname: 'Tom' }, sub_comments: [{ content: '在Zeedijk', user_info: { nickname: '小林' } }] }]);
  const post = read.post;
  assert.deepEqual([post.shape, post.title, post.text, post.author.name, post.author.url, post.community, post.postedAt, post.tags], ['photo', '阿姆斯特丹最好吃的火锅', '汤底很香 #火锅', '小林', 'https://www.xiaohongshu.com/user/profile/u1', '荷兰', '2025-10-30T04:53:20.000Z', ['火锅', '阿姆斯特丹美食']]);
  assert.deepEqual(post.counts, { likes: 12_000, saves: 3000, comments: 210 });
  assert.deepEqual(postCounts(post).map(item => item.label), ['likes', 'saves', 'comments']);
  assert.deepEqual(post.photos, [{ url: 'https://sns-webpic-qc.xhscdn.com/1.jpg', width: 1080, height: 1440 }, { url: 'https://sns-webpic-qc.xhscdn.com/2.jpg' }]);
  assert.deepEqual(post.comments, [{ author: 'Tom', text: '求地址', likes: 12, at: '2025-10-30T04:55:00.000Z' }, { author: '小林', text: '在Zeedijk', depth: 1 }]);
  assert.equal(post.url, `https://www.xiaohongshu.com/explore/${NOTE}?xsec_token=tok&xsec_source=pc_share`);
  const video = notePost({ noteId: NOTE, type: 'video', desc: '', user: { nickname: 'Mia' }, imageList: [{ urlDefault: 'https://c/1.jpg' }], video: { capa: { duration: 95 } } }, `https://www.xiaohongshu.com/explore/${NOTE}`, []).post;
  assert.deepEqual([video.shape, video.duration, video.notice?.startsWith('The video plays on Xiaohongshu')], ['video', 95, true]);
});

test('The signed-in browser refuses to read before a login and says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-signed-in-'));
  try {
    const signedIn = new SignedInBrowser(new BrowserService(null as unknown as Store, dir, { executable: null }), dir);
    const [site] = signedIn.status().sites;
    assert.deepEqual([site.id, site.name, site.signedIn, site.needsCheck, site.window, site.canWindow], ['xiaohongshu', 'Xiaohongshu', false, false, false, false]);
    const posts = new Posts({ signedIn });
    await assert.rejects(posts.search('xiaohongshu', '火锅', 5), /ros\.ai is not logged in to Xiaohongshu\. Ask the person to log in once in Plugins › Xiaohongshu/u);
    await assert.rejects(posts.read(`https://www.xiaohongshu.com/explore/${NOTE}`), /not logged in to Xiaohongshu/u);
    await assert.rejects(signedIn.login('xiaohongshu'), /There is no browser to run/u);
    await assert.rejects(new Posts().search('xiaohongshu', '火锅', 5), /signed-in browser, which this ros\.ai does not run/u);
    assert.deepEqual((await signedIn.logout('xiaohongshu')).sites[0].signedIn, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** Xiaohongshu's pages as stand-ins: they fetch what the real ones fetch for themselves. */
async function standIns(context: BrowserContext, state: { captcha: boolean; guest: boolean }) {
  const page = (body: string) => ({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><title>小红书</title></head><body>${body}</body></html>` });
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const me = `<script>fetch('/api/sns/web/v2/user/me').then(r=>r.json())</script>`;
  await context.route('https://www.xiaohongshu.com/**', async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/sns/web/v2/user/me') return route.fulfill(json({ code: 0, success: true, data: state.guest ? { guest: true } : { guest: false, nickname: '小林', user_id: 'u1' } }));
    if (url.pathname === '/website-login/captcha') return route.fulfill(page('请完成验证'));
    if (url.pathname === '/search_result') {
      if (state.captcha) return route.fulfill(page(`<script>location.replace('/website-login/captcha?redirectPath=x')</script>`));
      return route.fulfill(page(`${me}<script>fetch('/api/sns/web/v1/search/notes',{method:'POST',body:JSON.stringify({keyword:${JSON.stringify(url.searchParams.get('keyword'))}})}).then(r=>r.json())</script>`));
    }
    if (url.pathname === '/api/sns/web/v1/search/notes') return route.fulfill(json({ code: 0, success: true, data: { has_more: false, items: [
      { id: NOTE, xsec_token: 'tok', model_type: 'note', note_card: { display_title: '阿姆斯特丹最好吃的火锅', type: 'normal', user: { nickname: '小林' }, interact_info: { liked_count: '1.2万' }, cover: { url_default: 'https://sns-webpic-qc.xhscdn.com/1.jpg' } } },
      { id: '6720a1b2c3d4e5f600000002', xsec_token: 'tok2', model_type: 'note', note_card: { display_title: '火锅踩雷', type: 'normal', user: { nickname: 'Mia' }, interact_info: { liked_count: '45' } } },
    ] } }));
    if (url.pathname === `/explore/${NOTE}`) {
      const note = { noteId: NOTE, type: 'normal', title: '阿姆斯特丹最好吃的火锅', desc: '汤底很香 #火锅[话题]#', time: 1761800000000, ipLocation: '荷兰', user: { nickname: '小林', userId: 'u1' }, interactInfo: { likedCount: '1.2万', collectedCount: '3000', commentCount: '2' }, imageList: [{ urlDefault: 'https://sns-webpic-qc.xhscdn.com/1.jpg', width: 1080, height: 1440 }], tagList: [{ name: '火锅' }] };
      return route.fulfill(page(`<script>window.__INITIAL_STATE__={note:{noteDetailMap:{${JSON.stringify(NOTE)}:{note:${JSON.stringify(note)},comments:{list:[]}}}}};fetch('/api/sns/web/v2/comment/page?note_id=${NOTE}').then(r=>r.json())</script>`));
    }
    if (url.pathname === '/api/sns/web/v2/comment/page') return route.fulfill(json({ code: 0, success: true, data: { comments: [{ content: '求地址', like_count: '12', user_info: { nickname: 'Tom' }, sub_comments: [] }] } }));
    if (url.pathname === '/explore') return route.fulfill(page(me));
    return route.fulfill({ status: 404, body: '' });
  });
}

test('Signed in, ros.ai searches Xiaohongshu and reads a note the way its pages load, and stops when Xiaohongshu asks for a check', { skip: ENGINE ? false : 'There is no Chrome, Edge or Chromium on this computer.' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-signed-in-'));
  const state = { captcha: false, guest: false };
  const browser = new BrowserService(null as unknown as Store, dir, { isPublic: () => true });
  const signedIn = new SignedInBrowser(browser, dir, { gap: () => 0, prepare: context => standIns(context, state) });
  try {
    // A login the person made earlier, in the window.
    mkdirSync(join(dir, 'signed-in', 'xiaohongshu'), { recursive: true });
    writeFileSync(join(dir, 'signed-in', 'xiaohongshu.json'), JSON.stringify({ signedIn: false, userAgent: 'Mozilla/5.0 (Macintosh) Chrome/141.0 Safari/537.36' }));
    assert.deepEqual((await signedIn.check('xiaohongshu')).sites[0], { id: 'xiaohongshu', name: 'Xiaohongshu', signedIn: true, account: '小林', checkedAt: signedIn.status().sites[0].checkedAt, needsCheck: false, window: false, canWindow: signedIn.status().sites[0].canWindow });

    const posts = new Posts({ signedIn });
    const hits = await posts.search('xiaohongshu', '阿姆斯特丹 火锅', 5, 'top');
    assert.deepEqual(hits.map(hit => [hit.title, hit.author, hit.counts.likes]), [['阿姆斯特丹最好吃的火锅', '小林', 12_000], ['火锅踩雷', 'Mia', 45]]);
    assert.equal(hits[0].url, `https://www.xiaohongshu.com/explore/${NOTE}?xsec_token=tok&xsec_source=pc_search`);

    const read = await posts.read(hits[0].url);
    assert.deepEqual([read.post.title, read.post.text, read.post.community, read.post.counts.likes, read.post.photos.length, read.post.comments?.[0]?.text], ['阿姆斯特丹最好吃的火锅', '汤底很香 #火锅', '荷兰', 12_000, 1, '求地址']);

    // Xiaohongshu asks for a check: ros.ai stops, and keeps stopping until the person passes it in the window.
    state.captcha = true;
    await assert.rejects(posts.search('xiaohongshu', '火锅', 5), /Xiaohongshu asked for a check that a person is there, so ros\.ai stopped/u);
    assert.equal(signedIn.status().sites[0].needsCheck, true);
    state.captcha = false;
    await assert.rejects(posts.read(hits[0].url), /asked for a check that a person is there\. Ask the person to open Plugins › Xiaohongshu and press Log in/u);
    assert.equal(JSON.parse(readFileSync(join(dir, 'signed-in', 'xiaohongshu.json'), 'utf8')).userAgent, 'Mozilla/5.0 (Macintosh) Chrome/141.0 Safari/537.36');

    // Log out deletes the profile.
    assert.equal((await signedIn.logout('xiaohongshu')).sites[0].signedIn, false);
  } finally { await signedIn.shutdown(); await browser.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
