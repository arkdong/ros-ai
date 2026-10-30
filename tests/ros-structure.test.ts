import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { landingPlan, type LandingPlan } from '../src/server/ros-layer.js';
import { seeded } from '../training/ros-nemotron/generate.js';
import { ChatAdapter } from '../training/ros-nemotron/lib.js';
import { SMOKE_MAP, answerFor, askFor, makeCases, makeMap, scoreCase, summarise, tidyMap, toStructureSample, uniqueMaps } from '../training/ros-nemotron/structure.js';

// Round 2's structure family: well-organised maps lose their shape, and ROS learns to give it back, or to change nothing.

const canonical = (plan: LandingPlan) => JSON.stringify({
  place: plan.place.map(item => `${item.block}>${item.group}`).sort(),
  newGroups: plan.newGroups.map(group => `${group.title}:${[...group.blocks].sort().join(',')}`).sort(),
  links: plan.links.map(link => `${link.from}-${link.label}->${link.to}`).sort(),
});

test('a written map keeps only what holds: groups of two or more, labels from the list, links in the map’s words', () => {
  const map = tidyMap({
    title: 'Heat in **Amsterdam**',
    groups: [{ slug: 'sources', title: 'Sources', request: 'Find sources' }, { slug: 'lonely', title: 'Lonely' }],
    blocks: [
      { slug: 'q', title: 'Which neighbourhoods get hottest?', text: 'Thesis question.', label: 'Question' },
      { slug: 'ggd', title: 'GGD heat map', text: '2023 map.', group: 'sources', label: 'result' },
      { slug: 'knmi', title: 'KNMI station data', text: 'Daily maxima.', group: 'sources' },
      { slug: 'trees', title: 'Tree cover', text: 'Shade lowers heat.', group: 'lonely' },
      { slug: 'todo', title: 'Ask the GGD', text: 'Mail them.' },
      { slug: 'q', title: 'Duplicate slug', text: '' },
    ],
    links: [
      { from: 'ggd', to: 'q', word: 'Answers' }, { from: 'q', to: 'ggd', word: 'supports' },
      { from: 'knmi', to: 'q', word: 'informs' }, { from: 'trees', to: 'sources', word: 'part of' }, { from: 'todo', to: 'todo', word: 'builds on' },
    ],
  }, 'urban heat');
  assert(map);
  assert.equal(map.title, 'Heat in Amsterdam');
  assert.deepEqual(map.groups.map(group => group.slug), ['sources']);
  assert.deepEqual(map.blocks.map(block => [block.slug, block.group ?? null, block.label ?? null]), [['q', null, 'question'], ['ggd', 'sources', null], ['knmi', 'sources', null], ['trees', null, null], ['todo', null, null]]);
  assert.deepEqual(map.links, [{ from: 'ggd', to: 'q', word: 'answers' }]);
  assert.equal(tidyMap({ blocks: [{ slug: 'a', title: 'A' }], groups: [] }, 'x'), null);
});

test('every case of a map reads back, through the app’s own parser, as exactly the shape the map had', () => {
  const cases = makeCases(SMOKE_MAP, seeded(7));
  assert.deepEqual([...new Set(cases.map(item => item.kind))].sort(), ['leave', 'links', 'mixed', 'place', 'regroup']);
  for (const item of cases) {
    const sample = toStructureSample(item);
    assert(sample, item.id);
    assert.equal(sample.messages[0].role, 'system');
    const { view, asked } = askFor(item);
    assert.equal(sample.messages[1].content, asked.messages[1].content);
    assert.equal(canonical(landingPlan(sample.messages[2].content, asked, view, item.request)), canonical(item.target), item.kind);
  }
  // A block that fits no group and has no links: the answer is to change nothing.
  const leave = cases.find(item => item.kind === 'leave')!;
  assert.deepEqual(JSON.parse(toStructureSample(leave)!.messages[2].content), { place: [], newGroups: [], links: [], toMap: null });
  // A group pulled apart comes back under its own title, and blocks inside other groups are link ends the packet names.
  const regroup = cases.find(item => item.kind === 'regroup')!, packet = JSON.parse(askFor(regroup).asked.messages[1].content);
  assert(packet.blocks.some((block: { in?: string }) => block.in?.startsWith('g')));
  assert.equal(regroup.target.newGroups.length, 1);
});

test('the scores: the original shape is full marks, an empty answer only gets the quiet cases right', () => {
  const cases = makeCases(SMOKE_MAP, seeded(7));
  const original = summarise(cases.map(item => { const { view, asked } = askFor(item); return scoreCase(item, landingPlan(JSON.stringify(answerFor(item.target, asked)), asked, view, item.request)); }));
  assert.deepEqual([original.valid, original.group.f1, original.link.f1, original.link.word, original.leftAlone, original.missed, original.titleOverlap], [1, 1, 1, 1, 1, 0, 1]);
  const empty = summarise(cases.map(item => scoreCase(item, { place: [], newGroups: [], links: [] })));
  assert.deepEqual([empty.group.f1, empty.link.f1, empty.leftAlone, empty.missed], [0, 0, 1, 1]);
  // An answer that does not parse counts as invalid and changes nothing.
  assert.equal(summarise([scoreCase(cases[0], null)]).valid, 0);
  // A link the right way round with the wrong word still counts as the right pair.
  const links = cases.find(item => item.kind === 'links')!, flipped = links.target.links.map(link => ({ from: link.to, to: link.from, label: 'supports' }));
  const score = scoreCase(links, { place: [], newGroups: [], links: flipped });
  assert.deepEqual([score.link.tp, score.link.direction], [links.target.links.length, 0]);
});

test('one map per request: Token Factory’s error text is tried again, a bare map is taken, and the request names the titles before it', async () => {
  const bare = {
    title: 'Shade and street heat',
    groups: [{ slug: 'trees', title: 'Tree cover' }],
    blocks: [
      { slug: 'q', title: 'Does shade cool streets?', text: 'The question.', label: 'question' },
      { slug: 'canopy', title: 'Tree canopy map', text: 'RIVM, 2022.', group: 'trees' },
      { slug: 'logs', title: 'Street temperature logs', text: 'Two summers.', group: 'trees' },
      { slug: 'mail', title: 'Ask the municipality', text: 'Mail them.' },
      { slug: 'deaths', title: 'Heat deaths in 2019', text: 'CBS.' },
    ],
    links: [{ from: 'logs', to: 'q', word: 'answers' }],
  };
  const replies = ['[ERROR: Agent failed: request timed out after 90 seconds]', JSON.stringify(bare)], asked: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      asked.push(JSON.parse(body).messages.at(-1).content);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: replies.shift() } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const model = new ChatAdapter({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, key: 'test', model: 'teacher', contextTokens: 128_000, thinking: false, purpose: 'structure-maps', usdPerMillion: { input: 0, output: 0 } });
    const map = await makeMap(model, 'urban heat', 0, ['Heat in Amsterdam']);
    assert.equal(map?.title, 'Shade and street heat');
    assert.equal(asked.length, 2);
    assert.match(asked[1], /^Write one map in the domain: urban heat\. It .+\nTake another angle than the maps already written in this domain: Heat in Amsterdam\.$/su);
    // A title the domain already has, in other case or punctuation, counts once; the same title in another domain is its own map.
    assert.equal(uniqueMaps([map!, { ...map!, title: 'shade and street-heat!' }, { ...map!, domain: 'noise' }]).length, 2);
  } finally { server.close(); }
});
