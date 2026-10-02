import assert from 'node:assert/strict';
import test from 'node:test';
import { arrangeCanvas, GROUP_INSET, GROUP_FOOTER, LAYOUT_GAP } from '../src/shared/layout';
import type { Canvas, CanvasNode } from '../src/shared/types';

const node = (id: string, parentId?: string): CanvasNode => ({ id, title: `Title ${id}`, description: `Contents ${id}`, kind: 'topic', x: 50, y: 20, ...(parentId ? { parentId } : {}) });
const sample = (): Canvas => ({
  nodes: [node('a'), node('b'), node('c', 'a'), node('d', 'a'), node('e', 'c'), node('f', 'b'), node('g')],
  connections: [{ id: 'cross', source: 'e', target: 'f', label: 'Compare' }, { id: 'inside', source: 'c', target: 'd', label: '' }],
});

test('arrange is deterministic, idempotent, and does not mutate content, membership or relationships', () => {
  const original = sample(); const before = structuredClone(original);
  const options = { expandedIds: ['a', 'b', 'c'] };
  const first = arrangeCanvas(original, options);
  assert.deepEqual(original, before);
  assert.deepEqual(arrangeCanvas(first.canvas, options), first);
  const reversed = arrangeCanvas({ nodes: [...original.nodes].reverse(), connections: [...original.connections].reverse() }, options);
  assert.deepEqual(Object.fromEntries(first.canvas.nodes.map(n => [n.id, [n.x, n.y]])), Object.fromEntries(reversed.canvas.nodes.map(n => [n.id, [n.x, n.y]])));
  assert.deepEqual(first.canvas.connections, before.connections);
  assert.deepEqual(first.canvas.nodes.map(({ x: _x, y: _y, ...n }) => n), before.nodes.map(({ x: _x, y: _y, ...n }) => n));
  assert.ok(first.canvas.nodes.every(n => n.x % 24 === 0 && n.y % 24 === 0));
});

test('expanded nested groups and reserved artifact areas fit without sibling overlap', () => {
  const { canvas, sizes } = arrangeCanvas(sample(), { expandedIds: ['a', 'b', 'c'], extraContent: { a: { width: 744, height: 648 } } });
  for (const a of canvas.nodes) {
    for (const b of canvas.nodes) {
      if (a.id === b.id || (a.parentId || null) !== (b.parentId || null)) continue;
      assert.ok(a.x + sizes[a.id].width + LAYOUT_GAP <= b.x || b.x + sizes[b.id].width + LAYOUT_GAP <= a.x || a.y + sizes[a.id].height + LAYOUT_GAP <= b.y || b.y + sizes[b.id].height + LAYOUT_GAP <= a.y, `${a.id} overlaps ${b.id}`);
    }
    if (a.parentId) {
      assert.ok(a.x + sizes[a.id].width + GROUP_INSET.x * 2 <= sizes[a.parentId].width);
      assert.ok(a.y + sizes[a.id].height + GROUP_INSET.y + GROUP_FOOTER <= sizes[a.parentId].height);
    }
  }
  const childBottom = Math.max(...canvas.nodes.filter(n => n.parentId === 'a').map(n => n.y + sizes[n.id].height));
  assert.ok(sizes.a.height >= childBottom + LAYOUT_GAP + 648 + GROUP_INSET.y + GROUP_FOOTER);
});

test('unknown relationships preserve meaning without overriding the existing spatial reading order', () => {
  const graph = { nodes: ['a', 'b', 'c', 'd'].map(id => node(id)), connections: [{ id: 'edge', source: 'a', target: 'd', label: '' }] };
  const { canvas } = arrangeCanvas(graph);
  const a = canvas.nodes.find(n => n.id === 'a')!, d = canvas.nodes.find(n => n.id === 'd')!;
  assert.ok(d.y > a.y); assert.deepEqual(canvas.connections, graph.connections);
  const nested = arrangeCanvas(sample(), { expandedIds: ['a', 'b', 'c'] });
  assert.deepEqual(nested.canvas.connections, sample().connections);
  assert.equal(nested.canvas.nodes.find(n => n.id === 'f')!.parentId, 'b');
});

test('arrange handles an empty canvas and rejects broken parent graphs', () => {
  assert.deepEqual(arrangeCanvas({ nodes: [], connections: [] }), { canvas: { nodes: [], connections: [] }, sizes: {} });
  assert.throws(() => arrangeCanvas({ nodes: [node('a', 'b'), node('b', 'a')], connections: [] }), /cyclic/);
  assert.throws(() => arrangeCanvas({ nodes: [node('a', 'missing')], connections: [] }), /missing/);
});

test('collapsed cards wrap onto grid-aligned rows without server placement drift', () => {
  const { canvas, sizes } = arrangeCanvas({ nodes: Array.from({ length: 30 }, (_, index) => node(`note-${index}`)), connections: [] });
  assert.ok(canvas.nodes.some(n => n.y > 0), 'The fixture spans multiple shelves');
  assert.ok(canvas.nodes.every(n => n.x % 24 === 0 && n.y % 24 === 0));
  const minY = Math.min(...canvas.nodes.map(n => n.y));
  const firstRow = canvas.nodes.filter(n => n.y === minY);
  const nextY = Math.min(...canvas.nodes.filter(n => n.y > minY).map(n => n.y));
  assert.ok(nextY >= minY + Math.max(...firstRow.map(n => sizes[n.id].height)) + LAYOUT_GAP);
  assert.deepEqual(arrangeCanvas(canvas).canvas, canvas);
});

test('Arrange preserves visible reading order and the root corner instead of sorting by IDs', () => {
  const graph: Canvas = {nodes:[
    {...node('z-left'),x:960,y:720}, {...node('a-right'),x:1440,y:720},
    {...node('m-below'),x:960,y:1080}, {...node('b-last'),x:1440,y:1080},
  ],connections:[{id:'cross',source:'z-left',target:'b-last',label:'Related, not ordered'}]};
  const first=arrangeCanvas(graph).canvas;
  const reading=first.nodes.slice().sort((a,b)=>a.y-b.y||a.x-b.x).map(n=>n.id);
  assert.deepEqual(reading,['z-left','a-right','m-below','b-last']);
  assert.equal(Math.min(...first.nodes.map(n=>n.x)),960);
  assert.equal(Math.min(...first.nodes.map(n=>n.y)),720);
  assert.deepEqual(arrangeCanvas(first).canvas,first);
});

test('mixed group and result footprints align to common columns without shifting on a second Arrange', () => {
  const graph:Canvas={nodes:[
    {...node('a-group'),x:0,y:0},{...node('b-card'),x:1400,y:0},
    {...node('c-card'),x:0,y:1400},{...node('d-group'),x:1400,y:1400},
  ],connections:[]};
  const options={expandedIds:['a-group','d-group'],extraContent:{'a-group':{width:900,height:600},'d-group':{width:1100,height:400}}};
  const first=arrangeCanvas(graph,options);
  const byId=Object.fromEntries(first.canvas.nodes.map(n=>[n.id,n]));
  assert.equal(byId['a-group'].x,byId['c-card'].x);
  assert.equal(byId['b-card'].x,byId['d-group'].x);
  assert.equal(byId['a-group'].y,byId['b-card'].y);
  assert.equal(byId['c-card'].y,byId['d-group'].y);
  assert.deepEqual(arrangeCanvas(first.canvas,options),first);
});

test('a saved result offset is reserved after child notes compact without modifying the result layout', () => {
  const extraContent={a:{width:900,height:620,minY:1600}};
  const first=arrangeCanvas(sample(),{expandedIds:['a'],extraContent});
  assert.ok(first.sizes.a.height>=1600+620+GROUP_INSET.y+GROUP_FOOTER);
  assert.deepEqual(extraContent,{a:{width:900,height:620,minY:1600}});
  assert.deepEqual(arrangeCanvas(first.canvas,{expandedIds:['a'],extraContent}),first);
});

test('known evidence relationships arrange sources above consumers without rewriting captured links', () => {
  const graph: Canvas = { nodes: [
    { ...node('monthly'), x: 0, y: 0 }, { ...node('sandbox'), x: 700, y: 0 },
    { ...node('robustness'), x: 0, y: 500 }, { ...node('knmi'), x: 700, y: 500 },
  ], connections: [
    { id: 'source', source: 'monthly', target: 'knmi', label: 'uses data from', sourceHandle: 'left', targetHandle: 'bottom' },
    { id: 'remote-source', source: 'sandbox', target: 'knmi', label: 'uses data from' },
    { id: 'reuse', source: 'robustness', target: 'monthly', label: 'reuses result from' },
  ] };
  const before = structuredClone(graph), first = arrangeCanvas(graph);
  const notes = Object.fromEntries(first.canvas.nodes.map(n => [n.id, n]));
  assert.ok(notes.knmi.y + first.sizes.knmi.height + LAYOUT_GAP <= notes.monthly.y);
  assert.equal(notes.monthly.y, notes.sandbox.y, 'Independent consumers share one level');
  assert.ok(notes.monthly.y + first.sizes.monthly.height + LAYOUT_GAP <= notes.robustness.y);
  assert.ok(notes.monthly.x < notes.sandbox.x, 'Sibling branches retain their existing reading order');
  assert.deepEqual(first.canvas.connections, before.connections);
  assert.deepEqual(graph, before);
  assert.deepEqual(arrangeCanvas(first.canvas), first);
});

test('cyclic evidence relationships stay stable while downstream consumers still follow their sources', () => {
  const graph: Canvas = { nodes: ['a', 'b', 'c', 'unrelated'].map(id => node(id)), connections: [
    { id: 'ab', source: 'a', target: 'b', label: 'provides data to' },
    { id: 'ba', source: 'b', target: 'a', label: 'provides results to' },
    { id: 'bc', source: 'b', target: 'c', label: 'supports' },
    { id: 'unknown', source: 'c', target: 'unrelated', label: 'Contrasts with' },
  ] };
  const first = arrangeCanvas(graph), notes = Object.fromEntries(first.canvas.nodes.map(n => [n.id, n]));
  assert.equal(notes.a.y, notes.b.y);
  assert.ok(notes.c.y > Math.max(notes.a.y, notes.b.y));
  assert.ok(notes.unrelated.y < notes.c.y, 'Unknown relation does not invent a dependency');
  assert.deepEqual(arrangeCanvas(first.canvas), first);
  assert.deepEqual(first.canvas.connections, graph.connections);
});

test('measured card heights and saved widths determine gap and group bounds', () => {
  const graph: Canvas = { nodes: [node('group'), { ...node('a', 'group'), width: 700 }, node('b', 'group'), node('c', 'group')], connections: [] };
  const options = { expandedIds: ['group'], nodeSizes: { b: { width: 408, height: 390 }, c: { width: 408, height: 250 } } };
  const first = arrangeCanvas(graph, options), notes = Object.fromEntries(first.canvas.nodes.map(n => [n.id, n]));
  assert.equal(first.sizes.a.width, 700, 'Saved width applies before any browser measurement');
  assert.equal(first.sizes.b.height, 390);
  assert.ok(notes.b.x >= notes.a.x + 700 + LAYOUT_GAP);
  assert.ok(notes.c.y >= 390 + LAYOUT_GAP);
  assert.ok(first.sizes.group.width >= notes.b.x + first.sizes.b.width + GROUP_INSET.x * 2);
  assert.ok(first.sizes.group.height >= notes.c.y + first.sizes.c.height + GROUP_INSET.y + GROUP_FOOTER);
  assert.deepEqual(arrangeCanvas(first.canvas, options), first);
});

test('dependency edges across nested branches order their containing groups and preserve membership', () => {
  const graph: Canvas = { nodes: [node('consumer-group'), node('source-group'), node('consumer', 'consumer-group'), node('source', 'source-group')], connections: [
    { id: 'nested-evidence', source: 'consumer', target: 'source', label: 'uses data from' },
  ] };
  const options = { expandedIds: ['consumer-group', 'source-group'], extraContent: { 'source-group': { width: 600, height: 500 } } };
  const first = arrangeCanvas(graph, options), notes = Object.fromEntries(first.canvas.nodes.map(n => [n.id, n]));
  assert.ok(notes['consumer-group'].y >= notes['source-group'].y + first.sizes['source-group'].height + LAYOUT_GAP);
  assert.equal(notes.source.parentId, 'source-group'); assert.equal(notes.consumer.parentId, 'consumer-group');
  assert.deepEqual(first.canvas.connections, graph.connections);
  assert.deepEqual(arrangeCanvas(first.canvas, options), first);
});
