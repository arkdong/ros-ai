import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvasReflowPlan, reflowCanvas } from '../src/shared/canvas-reflow';
import { arrangeCanvas, GROUP_FOOTER, GROUP_INSET, type CanvasSize, type LayoutOptions } from '../src/shared/layout';
import type { Canvas, CanvasNode } from '../src/shared/types';

const note = (id: string, x = 0, y = 0, parentId?: string): CanvasNode => ({ id, title: id, description: '', kind: 'topic', x, y, ...(parentId ? { parentId } : {}) });
function separated(canvas: Canvas, sizes: Record<string, CanvasSize>) {
  for (const a of canvas.nodes) for (const b of canvas.nodes) {
    if (a.id === b.id || a.parentId !== b.parentId) continue;
    assert.ok(a.x + sizes[a.id].width + 32 <= b.x || b.x + sizes[b.id].width + 32 <= a.x || a.y + sizes[a.id].height + 32 <= b.y || b.y + sizes[b.id].height + 32 <= a.y, `${a.id} overlaps ${b.id}`);
  }
}
test('an arranged canvas reflows through expand, 2/4/All, page size, measured resize and collapse without drifting', () => {
  const source: Canvas = { nodes: [note('source', -192, -48), note('analysis', -192, 300), note('other', 300, 300), note('followup', -192, 700)], connections: [
    { id: 'in', source: 'source', target: 'analysis', label: 'provides data to' },
    { id: 'out', source: 'analysis', target: 'followup', label: 'provides results to' },
  ] };
  const arranged = arrangeCanvas(source), original = structuredClone(arranged.canvas);
  const plan = createCanvasReflowPlan(arranged.canvas, arranged.sizes);
  let current = arranged.canvas;
  const steps: LayoutOptions[] = [
    { expandedIds: ['analysis'], extraContent: { analysis: { width: 768, height: 300 } } },
    { expandedIds: ['analysis'], extraContent: { analysis: { width: 768, height: 648 } } },
    { expandedIds: ['analysis'], extraContent: { analysis: { width: 768, height: 1692 } } },
    { expandedIds: ['analysis'], extraContent: { analysis: { width: 360, height: 300 } } },
    { expandedIds: [], nodeSizes: { analysis: { width: 720, height: 410 } } },
    { expandedIds: [], nodeSizes: arranged.sizes },
  ];
  let expandedFollowupX = 0;
  for (const [index, options] of steps.entries()) {
    const next = reflowCanvas(current, plan, options);
    separated(next.canvas, next.sizes);
    assert.deepEqual(reflowCanvas(next.canvas, plan, options), next, 'Repeated measurements settle without new positions');
    assert.equal(next.canvas.nodes.find(node => node.id === 'source')!.x, -192);
    assert.equal(next.canvas.nodes.find(node => node.id === 'source')!.y, -48);
    const a = next.canvas.nodes.find(node => node.id === 'analysis')!, followup = next.canvas.nodes.find(node => node.id === 'followup')!;
    assert.ok(followup.x >= a.x + next.sizes.analysis.width + 32, 'Downstream direction remains right of its source');
    if (index === 2) expandedFollowupX = followup.x;
    if (index === 5) assert.ok(followup.x < expandedFollowupX, 'Collapse closes the expansion gap');
    current = next.canvas;
  }
  assert.deepEqual(current, original, 'A round trip returns to the arranged reading order and anchor');
  assert.deepEqual(arranged.canvas, original, 'Input is immutable');
});

test('nested siblings settle before ancestor frames and preserve containment and result space', () => {
  const graph: Canvas = { nodes: [note('root', -240, -72), note('neighbour', 500), note('a', 0, 0, 'root'), note('b', 480, 0, 'root'), note('inner', 0, 0, 'a')], connections: [] };
  const baseline = arrangeCanvas(graph, { expandedIds: ['root'] });
  const plan = createCanvasReflowPlan(baseline.canvas, baseline.sizes);
  const options = { expandedIds: ['root', 'a'], extraContent: { a: { width: 768, height: 1000 }, root: { width: 768, height: 300 } }, nodeSizes: { inner: { width: 720, height: 412 } } };
  const next = reflowCanvas(baseline.canvas, plan, options); separated(next.canvas, next.sizes);
  for (const node of next.canvas.nodes.filter(node => node.parentId)) {
    assert.ok(node.x >= 0 && node.y >= 0);
    assert.ok(node.x + next.sizes[node.id].width + GROUP_INSET.x * 2 <= next.sizes[node.parentId!].width);
    assert.ok(node.y + next.sizes[node.id].height + GROUP_INSET.y + GROUP_FOOTER <= next.sizes[node.parentId!].height);
  }
  assert.deepEqual(reflowCanvas(next.canvas, plan, options), next);
  assert.deepEqual(next.canvas.connections, graph.connections);
});

test('manual movement becomes the new anchor without zero clamping or later automatic snapback', () => {
  const graph: Canvas = { nodes: [note('a', 0, 0), note('b', 480, 0)], connections: [] };
  const initial = arrangeCanvas(graph);
  const first = reflowCanvas(initial.canvas, createCanvasReflowPlan(initial.canvas, initial.sizes), { nodeSizes: { a: { width: 720, height: 300 } } });
  first.canvas.nodes[0].x = -720; first.canvas.nodes[0].y = -480;
  const plan = createCanvasReflowPlan(first.canvas, first.sizes);
  const next = reflowCanvas(first.canvas, plan, { nodeSizes: { a: { width: 680, height: 420 } } });
  assert.equal(next.canvas.nodes[0].x, -720); assert.equal(next.canvas.nodes[0].y, -480);
  separated(next.canvas, next.sizes);
});

test('a manually moved downstream neighbour retains its chosen gap when it or its source is resized', () => {
  const graph: Canvas = { nodes: [note('left', 0, 0), note('right', 2400, 0)], connections: [] };
  const sizes = { left: { width: 408, height: 224 }, right: { width: 408, height: 224 } };
  const plan = createCanvasReflowPlan(graph, sizes);
  const widerRight = reflowCanvas(graph, plan, { nodeSizes: { ...sizes, right: { width: 600, height: 224 } } });
  assert.equal(widerRight.canvas.nodes[1].x, 2400, 'Resizing the moved card does not discard intentional manual spacing');
  const widerLeft = reflowCanvas(widerRight.canvas, plan, { nodeSizes: { ...sizes, left: { width: 720, height: 224 } } });
  assert.equal(widerLeft.canvas.nodes[1].x, 2712, 'The same gap remains when the preceding card grows');
  assert.deepEqual(reflowCanvas(widerLeft.canvas, plan, { nodeSizes: sizes }).canvas, graph, 'Shrink removes automatic displacement only');
});

test('a plan captured while expanded compacts transitive spacing after collapse', () => {
  const graph: Canvas = { nodes: [note('source'), note('analysis'), note('followup')], connections: [
    { id: 'input', source: 'source', target: 'analysis', label: 'provides data to' },
    { id: 'output', source: 'analysis', target: 'followup', label: 'provides results to' },
  ] };
  const expanded = arrangeCanvas(graph, { expandedIds: ['analysis'], extraContent: { analysis: { width: 768, height: 2000 } } });
  const plan = createCanvasReflowPlan(expanded.canvas, expanded.sizes);
  const collapsed = reflowCanvas(expanded.canvas, plan);
  const at = (canvas: Canvas, id: string) => canvas.nodes.find(node => node.id === id)!;
  const gap = (canvas: Canvas, sizes: Record<string, CanvasSize>, before: string, after: string) => at(canvas, after).x - at(canvas, before).x - sizes[before].width;
  assert.equal(gap(collapsed.canvas, collapsed.sizes, 'source', 'analysis'), gap(expanded.canvas, expanded.sizes, 'source', 'analysis'));
  assert.equal(gap(collapsed.canvas, collapsed.sizes, 'analysis', 'followup'), gap(expanded.canvas, expanded.sizes, 'analysis', 'followup'), 'A source-to-followup constraint must not retain space occupied by the expanded middle frame');
  assert.ok(at(collapsed.canvas, 'followup').x < at(expanded.canvas, 'followup').x);
});

test('a shorter parallel branch does not freeze a column width reserved for an expanded neighbour', () => {
  const graph: Canvas = { nodes: [note('source'), note('analysis'), note('parallel'), note('followup')], connections: [
    { id: 'input', source: 'source', target: 'analysis', label: 'provides data to' },
    { id: 'parallel-input', source: 'source', target: 'parallel', label: 'provides data to' },
    { id: 'output', source: 'analysis', target: 'followup', label: 'provides results to' },
  ] };
  const expanded = arrangeCanvas(graph, { expandedIds: ['analysis'], extraContent: { analysis: { width: 768, height: 2000 } } });
  const plan = createCanvasReflowPlan(expanded.canvas, expanded.sizes);
  const collapsed = reflowCanvas(expanded.canvas, plan);
  const at = (canvas: Canvas, id: string) => canvas.nodes.find(node => node.id === id)!;
  const analysis = at(collapsed.canvas, 'analysis'), parallel = at(collapsed.canvas, 'parallel'), followup = at(collapsed.canvas, 'followup');
  const gap = at(expanded.canvas, 'followup').x - at(expanded.canvas, 'analysis').x - expanded.sizes.analysis.width;
  assert.equal(analysis.x, parallel.x);
  assert.equal(followup.x, analysis.x + Math.max(collapsed.sizes.analysis.width, collapsed.sizes.parallel.width) + gap, 'The column keeps the gap after its widest closed block');
  separated(collapsed.canvas, collapsed.sizes);
});

test('cyclic relationships remain stable, malformed parent ownership rejects, and collapsed descendants retain layout', () => {
  const graph: Canvas = { nodes: [note('a'), note('b', 480), note('hidden1', 24, 48, 'a'), note('hidden2', 24, 48, 'a')], connections: [
    { id: 'ab', source: 'a', target: 'b', label: 'provides data to' }, { id: 'ba', source: 'b', target: 'a', label: 'provides data to' },
  ] };
  const plan = createCanvasReflowPlan(graph, {});
  const result = reflowCanvas(graph, plan, { nodeSizes: { a: { width: 720, height: 400 } } });
  assert.deepEqual(result.canvas.nodes.filter(node => node.parentId), graph.nodes.filter(node => node.parentId));
  assert.deepEqual(reflowCanvas(result.canvas, plan, { nodeSizes: { a: { width: 720, height: 400 } } }), result);
  assert.throws(() => reflowCanvas({ nodes: [note('a', 0, 0, 'b'), note('b', 0, 0, 'a')], connections: [] }, {}), /cyclic/);
  assert.throws(() => reflowCanvas({ nodes: [note('a', 0, 0, 'missing')], connections: [] }, {}), /missing/);
  assert.deepEqual(reflowCanvas({ nodes: [], connections: [] }, {}), { canvas: { nodes: [], connections: [] }, sizes: {}, plan: {} });
});
