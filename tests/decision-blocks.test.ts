import test from 'node:test';
import assert from 'node:assert/strict';
import { convertDecisionLogs, DECISION_LINK } from '../src/shared/decisions.js';
import { blockOrigin, labelPatch } from '../src/shared/vocabulary.js';
import type { Canvas } from '../src/shared/types.js';

const canvas = (): Canvas => ({
  nodes: [
    { id: 'group', title: 'Evidence', description: '', kind: 'group', x: 0, y: 0 },
    { id: 'analysis', title: 'Trend analysis', description: 'Monthly totals', kind: 'topic', blockType: 'note', parentId: 'group', x: 48, y: 24, decisions: [
      { id: 'd1', text: 'Use the 2024 series only', reason: 'Earlier years changed definition', at: '2026-10-09T14:05:00.000Z', basedOn: [{ artifactId: 'a1', hash: 'abcdef1234567890' }] },
      { id: 'd2', text: 'Drop the outlier week', reason: '', at: '2026-10-10T09:00:00.000Z', basedOn: [], withdrawnAt: '2026-10-11T08:00:00.000Z' },
    ] },
    { id: 'plain', title: 'Question', description: '', kind: 'topic', x: 0, y: 0, decisions: [] },
  ],
  connections: [{ id: 'c1', source: 'plain', target: 'analysis', label: '' }],
});

test('a block’s decision log becomes decision blocks linked to the block, keeping text, reason, basis and withdrawal', () => {
  const converted = convertDecisionLogs(canvas(), id => id === 'a1' ? 'totals.csv' : undefined);
  const analysis = converted.nodes.find(node => node.id === 'analysis')!;
  assert.equal('decisions' in analysis, false, 'the log leaves the block');
  const first = converted.nodes.find(node => node.id === 'd1')!, second = converted.nodes.find(node => node.id === 'd2')!;
  assert.equal(first.label, 'decision'); assert.equal(first.blockType, 'note'); assert.equal(first.parentId, 'group', 'a decision stays in the Group of its block');
  assert.equal(first.title, 'Use the 2024 series only');
  assert.match(first.description, /Reason: Earlier years changed definition/);
  assert.match(first.description, /Based on: totals.csv · version abcdef123456/);
  assert.match(first.description, /Recorded 2026-10-09 14:05 in “Trend analysis”/);
  assert.equal(second.title, 'Withdrawn: Drop the outlier week'); assert.match(second.description, /Withdrawn 2026-10-11 08:00/);
  assert.notEqual(first.y, second.y, 'decision blocks do not stack on one spot');
  assert.deepEqual(converted.connections.slice(1), [
    { id: 'decision-link-d1', source: 'd1', target: 'analysis', label: DECISION_LINK },
    { id: 'decision-link-d2', source: 'd2', target: 'analysis', label: DECISION_LINK },
  ]);
  assert.equal(convertDecisionLogs(converted), converted, 'a converted canvas is returned as it is');
  const empty = canvas(); empty.nodes[1].decisions = [];
  assert.equal(convertDecisionLogs(empty), empty, 'empty logs need no conversion');
});

test('the label patch clears an older Action block to a plain note and trims the researcher’s own word', () => {
  assert.deepEqual(labelPatch({ kind: 'topic', blockType: 'note' }, ' plan '), { label: 'plan' });
  assert.deepEqual(labelPatch({ kind: 'activity', blockType: 'action' }, ''), { label: '', kind: 'topic', blockType: 'note' });
  assert.deepEqual(labelPatch({ kind: 'activity' }, ''), { label: '', kind: 'topic' });
  assert.equal(labelPatch({ kind: 'topic' }, 'x'.repeat(50)).label!.length, 40);
});

test('a block’s origin is the Agent block its links lead back to, through Result notes and findings', () => {
  const nodes: Canvas['nodes'] = [
    { id: 'agent', title: 'Claude Code', description: '', blockType: 'agent', agent: { runtime: 'claude', turnId: 't' }, x: 0, y: 0 },
    { id: 'result', title: 'Rules', description: '', blockType: 'note', label: 'result', x: 0, y: 0 },
    { id: 'finding', title: 'Finding', description: '', blockType: 'finding', x: 0, y: 0 },
    { id: 'decision', title: 'Decision', description: '', blockType: 'note', label: 'decision', x: 0, y: 0 },
  ];
  const links = { nodes, connections: [
    { id: 'l0', source: 'decision', target: 'result', label: DECISION_LINK },
    { id: 'l1', source: 'agent', target: 'result', label: 'why' },
    { id: 'l2', source: 'result', target: 'finding', label: '' },
  ] };
  assert.equal(blockOrigin(links, 'finding'), 'Claude Code');
  assert.equal(blockOrigin(links, 'result'), 'Claude Code', 'a decision linked to a Result note does not hide its agent');
  assert.equal(blockOrigin(links, 'decision'), undefined);
});
