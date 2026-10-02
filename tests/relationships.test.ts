import test from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from '../src/shared/types.js';
import { displayRelationship, relationshipReferenceLabel } from '../src/shared/relationships.js';

const nodes = [{ id: 'source', title: 'KNMI observations' }, { id: 'consumer', title: 'Monthly analysis' }];
const inverse = (label: string): Connection => ({ id: 'relation', source: 'consumer', target: 'source', sourceHandle: 'left', targetHandle: 'bottom', label });

test('known inverse dependency labels display source to consumer and keep handles attached to their nodes', () => {
  const labels = new Map([['uses data from', 'provides data to'], ['reuses result from', 'provides results to'], ['reuses results from', 'provides results to'], ['uses results from', 'provides results to'], ['depends on', 'supports']]);
  for (const [label, expected] of labels) {
    const stored = inverse(label), before = structuredClone(stored);
    const display = displayRelationship(stored);
    assert.equal(display.source, 'source');
    assert.equal(display.target, 'consumer');
    assert.equal(display.sourceHandle, 'bottom');
    assert.equal(display.targetHandle, 'left');
    assert.equal(display.label, expected);
    assert.equal(display.reversed, true);
    assert.equal(display.dependency, true);
    assert.deepEqual(stored, before);
  }
});

test('relationship references use appropriate relative wording from both endpoints', () => {
  assert.equal(relationshipReferenceLabel(inverse(' Uses   Data From '), 'source', nodes), 'Provides data to → Monthly analysis');
  assert.equal(relationshipReferenceLabel(inverse('uses data from'), 'consumer', nodes), 'Data from ← KNMI observations');
  assert.equal(relationshipReferenceLabel(inverse('reuses result from'), 'source', nodes), 'Provides results to → Monthly analysis');
  assert.equal(relationshipReferenceLabel(inverse('reuses result from'), 'consumer', nodes), 'Results from ← KNMI observations');
  assert.equal(relationshipReferenceLabel(inverse('depends on'), 'source', nodes), 'Supports → Monthly analysis');
  assert.equal(relationshipReferenceLabel(inverse('depends on'), 'consumer', nodes), 'Supported by ← KNMI observations');
});

test('forward dependency direction and explicit handles remain unchanged', () => {
  for (const label of ['provides data to', 'provides results to', 'supports', 'feeds into']) {
    const stored: Connection = { id: 'relation', source: 'source', target: 'consumer', label, sourceHandle: 'right', targetHandle: 'top' };
    const display = displayRelationship(stored);
    assert.equal(display.reversed, false);
    assert.equal(display.dependency, true);
    assert.equal(display.source, stored.source);
    assert.equal(display.target, stored.target);
    assert.equal(display.sourceHandle, stored.sourceHandle);
    assert.equal(display.targetHandle, stored.targetHandle);
  }
  assert.equal(relationshipReferenceLabel({ id: 'r', source: 'source', target: 'consumer', label: 'feeds into' }, 'consumer', nodes), 'Fed by ← KNMI observations');
});

test('free-form and empty labels show explicit stored direction without inventing an inverse', () => {
  const stored = inverse('challenges the assumption in'), before = structuredClone(stored);
  const display = displayRelationship(stored);
  assert.equal(display.source, 'consumer');
  assert.equal(display.target, 'source');
  assert.equal(display.label, 'challenges the assumption in');
  assert.equal(display.reversed, false);
  assert.equal(display.dependency, false);
  for (const endpoint of ['source', 'consumer']) assert.equal(relationshipReferenceLabel(stored, endpoint, nodes), 'Monthly analysis → KNMI observations · challenges the assumption in');
  assert.deepEqual(stored, before);
  assert.equal(relationshipReferenceLabel({ ...stored, label: '' }, 'source', nodes), 'Monthly analysis → KNMI observations');
  assert.equal(displayRelationship(inverse('Uses data from, but only if verified')).reversed, false);
});
