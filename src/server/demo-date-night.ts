import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Artifact, CanvasNode, Mutation } from '../shared/types.js';
import type { TutorialExecution, TutorialSession, TutorialStage } from '../shared/tutorial.js';
import { estimatedSize } from '../shared/card-size.js';
import { arrangeCanvas } from '../shared/layout.js';
import { canvasAfter } from './agent-tools.js';
import { Store, StoreError } from './store.js';
import type { ImportArtifact } from './tutorial.js';

/** A real restaurant, as public guides describe it; `aside` says why it does not fit the plan, `source` where the facts come from. */
type Place = { id: string; name: string; cuisine: string; area: string; address: string; lat: number; lon: number; price: string; about: string; date: string; book: string; url: string; source: string; aside?: string };
type Content = {
  title: string; note: string; idea: { title: string; text: string };
  agents: { key: string; runtime: 'claude' | 'codex'; title: string; text: string; cuisines: string[] }[];
  cuisines: Record<string, { title: string; color: string }>; places: Place[]; pick: { title: string; text: string };
};
/** Photo credits, by file name; a photo without one is labelled as an illustration made for the demo. */
type Credits = Record<string, { title: string; credit?: string; licence?: string; url?: string }>;
export type DateNightSession = { projectId: string; scenario: 'date-night'; step: number; createdAt: string; nodes: Record<string, string> };

export const DATE_NIGHT_TITLE = 'Demo · Date night in Amsterdam';
const source = (path: string) => fileURLToPath(new URL(`../../examples/demo-date-night/${path}`, import.meta.url));
const STEPS: { label: string; title: string; summary: string; live: string; next?: string }[] = [
  { label: 'Plan', title: 'Say what you want', next: 'Send two agents to search',
    summary: 'The canvas starts with the plan in your own words: a date next Friday, four cuisines you like, a budget, and what you want to see.',
    live: 'In the app you type this to ROS, or write it as a block yourself.' },
  { label: 'Search', title: 'Two agents search at once', next: 'Check how to book',
    summary: 'Claude Code takes Japanese and French, Codex takes Asian and Spanish. They work side by side and put twelve real Amsterdam restaurants on the canvas, grouped by cuisine, each with its address, price and source.',
    live: 'In the app each agent runs in its own ROS thread with web search, and you see both working at the same time.' },
  { label: 'Book', title: 'Check how to book', next: 'Put them on a map',
    summary: 'Address, price and how to book for all twelve land in one Data block. Two places that do not fit move to a group of their own: one is over budget, one is hard to book for two.',
    live: 'This recorded tour does not check Friday\'s tables. In the app, an agent opens each booking page and checks Friday 6 November at 19:30 live.' },
  { label: 'Map', title: 'See them on a map', next: 'Bring in the photos',
    summary: 'Every restaurant on one map at its real address, coloured by cuisine. A hollow pin means set aside, so the options near you stand out at a glance.',
    live: 'Open the map. In the app this can be an interactive App block that reads the Data block.' },
  { label: 'Photos', title: 'Look at the food and the room', next: 'Pick the table',
    summary: 'For each place still in the running, a picture of the food and one of the room sit next to it on the canvas. Here they are illustrations; each links to a page about the restaurant.',
    live: 'In the app, agents save the real photos from the restaurants\' own pages as File blocks.' },
  { label: 'Pick', title: 'Pick the table',
    summary: 'The choice for Friday, with a second option and something different, each with why and how to book. It links back to the places and the map.',
    live: 'In the app you would say which one, and an agent with a booking plugin reserves it.' },
];
export const DATE_NIGHT_STEPS = STEPS.length;
/** The places the pick weighs up, linked to it on the canvas. */
const SHORTLIST = ['delamer', 'hosokawa', 'blauw'];
const csv = (value: string) => /[",\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const now = () => new Date().toISOString();

let loaded: Content | undefined;
const content = () => loaded ??= JSON.parse(readFileSync(source('places.json'), 'utf8')) as Content;
const credits = (): Credits => existsSync(source('photos/credits.json')) ? JSON.parse(readFileSync(source('photos/credits.json'), 'utf8')) as Credits : {};
/** The photos saved with the demo for one place: photos/<place id>-<n>.<jpg|png|webp>, in name order. */
const photos = (placeId: string) => existsSync(source('photos'))
  ? readdirSync(source('photos')).filter(name => name.startsWith(`${placeId}-`) && /\.(jpe?g|png|webp)$/iu.test(name)).sort() : [];
const booked = (place: Place) => Boolean(place.aside);
const mediaType = (name: string) => name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg';

/** Date night: a recorded tour of a personal search. Next adds each step's blocks from sample data saved with the demo,
 * so it makes no model, search or booking calls, and needs no project folder. */
export class DateNightTutorial {
  constructor(private store: Store, private importArtifacts: (projectId: string, nodeId: string, artifacts: ImportArtifact[], request: string) => Artifact[]) {}

  create(): string {
    const data = content(), project = this.store.createProject(DATE_NIGHT_TITLE);
    return this.store.atomic(() => {
      const session: DateNightSession = { projectId: project.id, scenario: 'date-night', step: 0, createdAt: now(), nodes: {} };
      this.step(session, [{ type: 'addNode', node: this.node(session, 'idea', { title: data.idea.title, description: data.idea.text, kind: 'topic', blockType: 'note', label: 'plan' }) }], 'Demo: the plan');
      this.store.addMessage(project.id, null, 'system', `This demo builds the canvas in six steps as you press Next in the demo guide. ${data.note}`);
      this.save(session);
      return project.id;
    });
  }

  read(session: DateNightSession, execution: TutorialExecution): TutorialSession {
    const data = content(), live = new Set(this.store.getProject(session.projectId).canvas.nodes.map(node => node.id));
    const id = (key: string) => { const value = session.nodes[key]; return value && live.has(value) ? [value] : []; };
    const open = data.places.filter(place => !booked(place));
    const frames = [['idea'], ['idea', ...data.agents.map(agent => `agent:${agent.key}`), ...Object.keys(data.cuisines).map(key => `group:${key}`)],
      ['tables', 'group:booked', ...Object.keys(data.cuisines).map(key => `group:${key}`)], ['tables', 'map'],
      open.map(place => `photos:${place.id}`), ['pick', 'map', ...SHORTLIST.map(id => `place:${id}`)]];
    const opens = [[['Open the plan', 'idea']], [['Open Claude Code', 'agent:claude'], ['Open Codex', 'agent:codex'], ['Open a restaurant', `place:${SHORTLIST[0]}`]],
      [['Open how to book', 'tables'], ['Set aside', 'group:booked']], [['Open the map', 'map']],
      SHORTLIST.map(key => [data.places.find(place => place.id === key)?.name ?? key, `photos:${key}`]), [['Open the pick', 'pick'], ['Open the map', 'map']]];
    const stages: TutorialStage[] = STEPS.map((step, index) => {
      const done = index <= session.step, frame = done ? frames[index].flatMap(id) : [];
      return { index, title: step.title, nodeId: frame[0] ?? null, summary: step.summary, status: done ? 'completed' : 'pending', label: step.label, live: step.live, next: step.next, frame,
        open: done ? opens[index].flatMap(([label, key]) => id(key).map(nodeId => ({ label, nodeId }))) : [] };
    });
    return { projectId: session.projectId, scenario: 'date-night', title: data.title, step: session.step, stages, runId: null, preview: null, outputArtifactIds: [], freshOutputArtifactIds: [],
      draftNodeId: session.nodes.pick ?? null, draftArtifactId: null, execution, notice: data.note, createdAt: session.createdAt };
  }

  advance(session: DateNightSession): void {
    if (session.step >= STEPS.length - 1) return;
    const data = content(), { projectId } = session, step = session.step + 1;
    const need = (key: string) => {
      const node = this.store.getProject(projectId).canvas.nodes.find(item => item.id === session.nodes[key]);
      if (!node) throw new StoreError('A block the next step builds on is no longer on the canvas. Undo its removal, or start the demo again.', 409);
      return node;
    };
    this.store.atomic(() => {
      if (step === 1) {
        const idea = need('idea'), operations: Mutation[] = [];
        for (const agent of data.agents) {
          const block = this.node(session, `agent:${agent.key}`, { title: agent.title, kind: 'activity', blockType: 'agent', agent: { runtime: agent.runtime, turnId: randomUUID() },
            description: `${agent.text}\n\n*Recorded for this demo: in a live run this agent searches the web from ros.ai while the other works at the same time.*` });
          operations.push({ type: 'addNode', node: block }, this.link(idea.id, block.id, 'taken on by'));
          for (const cuisine of agent.cuisines) {
            const places = data.places.filter(place => place.cuisine === cuisine);
            const group = this.node(session, `group:${cuisine}`, { title: data.cuisines[cuisine].title, description: `${places.length} places for a date, found by ${agent.runtime === 'claude' ? 'Claude Code' : 'Codex'}.`, kind: 'group' });
            operations.push({ type: 'addNode', node: group }, this.link(block.id, group.id, 'found'));
            places.forEach((place, index) => operations.push({ type: 'addNode', node: { ...this.node(session, `place:${place.id}`, { title: place.name, kind: 'topic', blockType: 'note', label: 'place',
              description: `**${data.cuisines[cuisine].title} · ${place.area} · ${place.price}**\n\n${place.about}\n\n${place.date}\n\n${place.address}, Amsterdam · [about this place](${place.url}) · [source](${place.source})` }), parentId: group.id, x: 0, y: index } }));
          }
        }
        this.step(session, operations, 'Demo: Claude Code and Codex search for restaurants side by side');
      } else if (step === 2) {
        const operations: Mutation[] = [], tables = this.node(session, 'tables', { title: 'How to book · Friday 6 November', description: '', kind: 'topic', blockType: 'dataset' });
        const rows = [['restaurant', 'cuisine', 'area', 'address', 'price', 'how_to_book', 'friday_19_30', 'source'], ...data.places.map(place => [place.name, data.cuisines[place.cuisine].title, place.area, place.address, place.price, place.book, place.aside ? 'set aside' : 'check live', place.source])];
        operations.push({ type: 'addNode', node: tables }, this.link(need('idea').id, tables.id, 'how to book'));
        const out = data.places.filter(booked), aside = this.node(session, 'group:booked', { title: 'Set aside', kind: 'group',
          description: `Set aside, not deleted: drag one out if it suits you after all.\n\n${out.map(place => `- **${place.name}:** ${place.aside}`).join('\n')}` });
        operations.push({ type: 'addNode', node: aside }, this.link(tables.id, aside.id, 'set aside'));
        out.forEach((place, index) => operations.push({ type: 'updateNode', id: need(`place:${place.id}`).id, patch: { parentId: aside.id, x: 0, y: index } }));
        this.step(session, operations, 'Demo: how to book each place, and set aside two that do not fit');
        const [dataset] = this.importArtifacts(projectId, tables.id, [{ kind: 'dataset', title: tables.title, content: rows.map(row => row.map(csv).join(',')).join('\n'), mediaType: 'text/csv',
          metadata: { tutorialOrigin: 'prepared', provenance: data.note } }], 'Load how to book each place');
        this.store.mutate(projectId, [{ type: 'updateNode', id: tables.id, patch: { artifactId: dataset.id } }], 'Demo: how to book');
      } else if (step === 3) {
        const tables = need('tables'), map = this.node(session, 'map', { title: 'Map · twelve restaurants in Amsterdam', description: '', kind: 'topic', blockType: 'figure' });
        this.step(session, [{ type: 'addNode', node: map }, this.link(tables.id, map.id, 'mapped')], 'Demo: put every restaurant on a map');
        const [image] = this.importArtifacts(projectId, map.id, [{ kind: 'plot', title: map.title, content: readFileSync(source('map.png')).toString('base64'), mediaType: 'image/png',
          metadata: { tutorialOrigin: 'prepared', contentEncoding: 'base64', provenance: 'Drawn for this demo from the places\' addresses (examples/demo-date-night/make-map.cjs); a simplified map, positions approximate.' } }], 'Load the demo map');
        this.store.mutate(projectId, [{ type: 'updateNode', id: map.id, patch: { artifactId: image.id } }], 'Demo: the map');
      } else if (step === 4) {
        const operations: Mutation[] = [], figures: { node: CanvasNode; file: string; name: string }[] = [], saved = credits();
        for (const place of data.places.filter(item => !booked(item))) {
          const files = photos(place.id);
          if (!files.length) throw new StoreError(`The demo has no photos for ${place.name}.`, 500);
          const group = this.node(session, `photos:${place.id}`, { title: `${place.name} · photos`, description: '', kind: 'group' });
          operations.push({ type: 'addNode', node: group }, this.link(need(`place:${place.id}`).id, group.id, 'photos'));
          files.forEach((file, index) => {
            const node: CanvasNode = { ...this.node(session, `photo:${file}`, { title: saved[file]?.title ?? `${place.name} ${index + 1}`, description: '', kind: 'topic', blockType: 'figure' }), parentId: group.id, x: 0, y: index };
            operations.push({ type: 'addNode', node });
            figures.push({ node, file, name: place.name });
          });
        }
        this.step(session, operations, 'Demo: photos of the food and the room');
        for (const { node, file, name } of figures) {
          const credit = saved[file], [image] = this.importArtifacts(projectId, node.id, [{ kind: 'plot', title: node.title, content: readFileSync(source(`photos/${file}`)).toString('base64'), mediaType: mediaType(file),
            ...(credit?.url ? { url: credit.url } : {}),
            metadata: { tutorialOrigin: 'prepared', contentEncoding: 'base64', provenance: credit?.credit ? `Photo: ${credit.credit}${credit.licence ? `, ${credit.licence}` : ''}. Stands in for the restaurant in this demo.` : `An illustration made for this demo, not a photo of ${name}.` } }], 'Load a demo photo');
          this.store.mutate(projectId, [{ type: 'updateNode', id: node.id, patch: { artifactId: image.id } }], 'Demo: a photo');
        }
      } else {
        const pick = this.node(session, 'pick', { title: data.pick.title, description: data.pick.text, kind: 'topic', blockType: 'note', label: 'decision' });
        this.step(session, [{ type: 'addNode', node: pick }, ...SHORTLIST.map(id => this.link(need(`place:${id}`).id, pick.id, 'shortlist')), this.link(need('map').id, pick.id, 'checked on')], 'Demo: pick the table for Friday');
      }
      session.step = step;
      this.save(session);
    });
  }

  private save(session: DateNightSession) { this.store.saveRecord('demo-session', session.projectId, session.projectId, session); }

  private node(session: DateNightSession, key: string, value: Omit<CanvasNode, 'id' | 'x' | 'y' | 'parentId'>): CanvasNode {
    const node: CanvasNode = { id: randomUUID(), parentId: null, x: 0, y: 0, ...value };
    session.nodes[key] = node.id;
    return node;
  }

  private link(source: string, target: string, label: string): Mutation { return { type: 'addConnection', connection: { id: randomUUID(), source, target, label } }; }

  /** One undoable change, with the demo's blocks laid out again as a tree that keeps the plan where it is (as the workflow demo does). */
  private step(session: DateNightSession, operations: Mutation[], label: string) {
    const canvas = canvasAfter(this.store.getProject(session.projectId).canvas, operations), order = new Map(Object.values(session.nodes).map((id, index) => [id, index]));
    const nodes = canvas.nodes.filter(node => order.has(node.id)).map(node => ({ ...node, x: node.parentId ? node.x : 0, y: node.parentId ? node.y : order.get(node.id)! }));
    const tree = { nodes, connections: canvas.connections.filter(edge => order.has(edge.source) && order.has(edge.target)) };
    const laid = arrangeCanvas(tree, { nodeSizes: Object.fromEntries(nodes.map(node => [node.id, estimatedSize(tree, node)])) }).canvas.nodes;
    const idea = canvas.nodes.find(node => node.id === session.nodes.idea), at = idea && laid.find(node => node.id === idea.id);
    const shift = idea && at ? { x: idea.x - at.x, y: idea.y - at.y } : { x: 0, y: 0 };
    const added = new Set(operations.flatMap(operation => operation.type === 'addNode' ? [operation.node.id] : []));
    const moves: Mutation[] = laid.flatMap(node => {
      const to = node.parentId ? { x: node.x, y: node.y } : { x: node.x + shift.x, y: node.y + shift.y }, from = canvas.nodes.find(item => item.id === node.id)!;
      return added.has(node.id) || from.x !== to.x || from.y !== to.y ? [{ type: 'updateNode' as const, id: node.id, patch: to }] : [];
    });
    this.store.mutate(session.projectId, [...operations, ...moves], label);
  }
}
