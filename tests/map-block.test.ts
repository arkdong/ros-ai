import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import type { ExecutionService } from '../src/server/execution.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { AgentWorkspaceTools } from '../src/server/agent-tools.js';
import { Geocoder } from '../src/server/geocode.js';
import { googleMapsLink, googleRouteLink, pointInLink } from '../src/shared/maps.js';

// A stand-in OpenStreetMap that knows two places in Amsterdam.
const PLACES: Record<string, { name: string; display_name: string; lat: string; lon: string }> = {
  'rijksmuseum, amsterdam': { name: 'Rijksmuseum', display_name: 'Rijksmuseum, Museumstraat 1, Amsterdam, Netherlands', lat: '52.3600', lon: '4.8852' },
  'café de jaren, amsterdam': { name: 'Café de Jaren', display_name: 'Café de Jaren, Nieuwe Doelenstraat 20, Amsterdam, Netherlands', lat: '52.3681', lon: '4.8955' },
};
function osm() {
  const asked: string[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input)), q = url.searchParams.get('q') ?? '';
    asked.push(q);
    assert.match(String((init?.headers as Record<string, string>)['User-Agent']), /^ros\.ai /u);
    const found = PLACES[q.toLowerCase()];
    return new Response(JSON.stringify(found ? [{ ...found, osm_type: 'way', osm_id: 1 }] : []), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { asked, geocoder: new Geocoder(fetcher, async () => undefined) };
}
const toolkit = (store: Store, projectId: string) => new AgentWorkspaceTools(store, { searchService: () => ({ id: 'tavily' }), assistantProposal: (id: string, summary: string, operations: Parameters<Store['createProposal']>[3]) => store.createProposal(id, store.getProject(id).revision, summary, operations) } as unknown as ExecutionService, { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService, { projectId, nodeIds: [], artifactIds: [] }, 'turn-map', 'claude');

test('Pins open in Google Maps without a key, and a pasted Google Maps link or "lat, lng" gives a point', () => {
  assert.equal(googleMapsLink({ name: 'Rijksmuseum', lat: 52.36, lng: 4.8852 }), 'https://www.google.com/maps/search/?api=1&query=Rijksmuseum%2052.360000%2C4.885200');
  assert.equal(googleRouteLink([{ lat: 1, lng: 2 }]), undefined);
  assert.equal(googleRouteLink([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { lat: 5, lng: 6 }]), 'https://www.google.com/maps/dir/?api=1&origin=1.000000,2.000000&destination=5.000000,6.000000&waypoints=3.000000%2C4.000000');
  assert.deepEqual(pointInLink('https://www.google.com/maps/place/Rijksmuseum/@52.3599976,4.8852188,17z/data=x'), { lat: 52.3599976, lng: 4.8852188 });
  assert.deepEqual(pointInLink(' 52.37, 4.89 '), { lat: 52.37, lng: 4.89 });
  assert.equal(pointInLink('Rijksmuseum'), undefined);
  assert.equal(pointInLink('95, 4'), undefined);
});

test('Agents put places on a new Map block by name, lat and lng, then add to it; places OpenStreetMap does not know are reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-map-')), store = new Store(join(dir, 'store')), { asked, geocoder } = osm();
  AgentWorkspaceTools.geocoder = geocoder;
  try {
    const project = store.createProject('Date night');
    const agent = toolkit(store, project.id);
    assert(agent.definitions.some(tool => tool.name === 'ros_place_pins'));
    const first = await agent.call('ros_place_pins', { summary: 'Map the evening', rationale: 'The person asked where everything is.', title: 'Date night in Amsterdam', pins: [
      { name: 'Rijksmuseum', place: 'Rijksmuseum, Amsterdam', note: 'Open until 22:00 on Fridays' },
      { name: 'Café de Jaren', place: 'Café de Jaren, Amsterdam', url: 'https://cafedejaren.nl/' },
      { name: 'Vondelpark bench', lat: 52.358, lng: 4.8686 },
      { name: 'Nowhere bar', place: 'Nowhere bar, Atlantis' },
    ] }) as { action: { proposalId: string }; committed: boolean; nodeId: string; placed: { name: string; foundAs?: string; google: string }[]; notFound: { name: string }[] };
    assert.equal(first.committed, false);
    assert.deepEqual(first.placed.map(pin => pin.name), ['Rijksmuseum', 'Café de Jaren', 'Vondelpark bench']);
    assert.match(first.placed[0].foundAs!, /Museumstraat 1/u);
    assert.deepEqual(first.notFound.map(pin => pin.name), ['Nowhere bar']);
    // Only pins without lat and lng are looked up.
    assert.deepEqual(asked, ['Rijksmuseum, Amsterdam', 'Café de Jaren, Amsterdam', 'Nowhere bar, Atlantis']);

    store.acceptProposal(project.id, first.action.proposalId);
    const map = store.getProject(project.id).canvas.nodes.find(n => n.id === first.nodeId)!;
    assert.equal(map.blockType, 'map');
    assert.equal(map.map!.provider, undefined);
    assert.deepEqual(map.map!.pins.map(pin => [pin.name, pin.lat, pin.lng]), [['Rijksmuseum', 52.36, 4.8852], ['Café de Jaren', 52.3681, 4.8955], ['Vondelpark bench', 52.358, 4.8686]]);
    assert.equal(map.map!.pins[1].url, 'https://cafedejaren.nl/');

    // A pin with a name already on the map moves it; a new name adds one.
    const second = await toolkit(store, project.id).call('ros_place_pins', { summary: 'Fix the bench', rationale: 'It was the wrong bench.', nodeId: map.id, pins: [{ name: 'vondelpark bench', lat: 52.3575, lng: 4.8701 }, { name: 'Tram stop', lat: 52.3622, lng: 4.8835 }] }) as { action: { proposalId: string } };
    store.acceptProposal(project.id, second.action.proposalId);
    const after = store.getProject(project.id).canvas.nodes.find(n => n.id === map.id)!.map!.pins;
    assert.deepEqual(after.map(pin => [pin.name, pin.lng]), [['Rijksmuseum', 4.8852], ['Café de Jaren', 4.8955], ['vondelpark bench', 4.8701], ['Tram stop', 4.8835]]);
    assert.equal(after[2].id, map.map!.pins[2].id);

    // ros_read_canvas shows the pins, and a block that is not a map takes none.
    const read = await toolkit(store, project.id).call('ros_read_canvas', { nodeIds: [map.id] }) as { blocks: { map?: { pins: unknown[] } }[] };
    assert.equal(read.blocks[0].map?.pins.length, 4);
    store.mutate(project.id, [{ type: 'addNode', node: { id: 'note', title: 'Plan', description: '', kind: 'topic', x: 0, y: 600 } }], 'Add note');
    await assert.rejects(toolkit(store, project.id).call('ros_place_pins', { summary: 'x', rationale: 'y', nodeId: 'note', pins: [{ name: 'A', lat: 1, lng: 1 }] }), /not a Map block/u);
    await assert.rejects(toolkit(store, project.id).call('ros_place_pins', { summary: 'x', rationale: 'y', pins: [{ name: 'A', lat: 1, lng: 1 }] }), /Give a title/u);

    // A Google Maps block when asked for, or by default once a Google Maps key is saved; adding pins keeps it one.
    const wanted = await toolkit(store, project.id).call('ros_place_pins', { summary: 'Google map', rationale: 'Asked for Google Maps.', title: 'On Google', on: 'google', pins: [{ name: 'Dam', lat: 52.373, lng: 4.8932 }] }) as { action: { proposalId: string }; nodeId: string; googleMaps?: string };
    assert.match(wanted.googleMaps!, /No Google Maps key/u);
    store.acceptProposal(project.id, wanted.action.proposalId);
    const added = await toolkit(store, project.id).call('ros_place_pins', { summary: 'More', rationale: 'More.', nodeId: wanted.nodeId, pins: [{ name: 'Station', lat: 52.379, lng: 4.9 }] }) as { action: { proposalId: string } };
    store.acceptProposal(project.id, added.action.proposalId);
    assert.equal(store.getProject(project.id).canvas.nodes.find(n => n.id === wanted.nodeId)!.map!.provider, 'google');
    process.env.GOOGLE_MAPS_API_KEY = 'AIza-test-key-0000';
    try {
      const keyed = await toolkit(store, project.id).call('ros_place_pins', { summary: 'Default', rationale: 'Key saved.', title: 'Default map', pins: [{ name: 'Dam', lat: 52.373, lng: 4.8932 }] }) as { action: { proposalId: string }; nodeId: string; googleMaps?: string };
      assert.equal(keyed.googleMaps, undefined);
      store.acceptProposal(project.id, keyed.action.proposalId);
      assert.equal(store.getProject(project.id).canvas.nodes.find(n => n.id === keyed.nodeId)!.map!.provider, 'google');
    } finally { delete process.env.GOOGLE_MAPS_API_KEY; }
  } finally { AgentWorkspaceTools.geocoder = undefined; store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('The person\'s own edit keeps a map\'s pins within bounds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-map-')), store = new Store(join(dir, 'store'));
  try {
    const project = store.createProject('Bounds');
    store.mutate(project.id, [{ type: 'addNode', node: { id: 'm', title: 'Map', description: '', kind: 'topic', blockType: 'map', map: { pins: [] }, x: 0, y: 0 } }], 'Add Map');
    assert.throws(() => store.mutate(project.id, [{ type: 'updateNode', id: 'm', patch: { map: { pins: [{ id: 'p', name: 'Off the globe', lat: 120, lng: 0 }] } } }], 'Bad pin'));
    store.mutate(project.id, [{ type: 'updateNode', id: 'm', patch: { map: { pins: [{ id: 'p', name: 'Delft', lat: 52.0116, lng: 4.3571 }] } } }], 'Pin Delft');
    assert.equal(store.getProject(project.id).canvas.nodes[0].map!.pins[0].name, 'Delft');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
