import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Artifact, CanvasNode, Mutation } from '../shared/types.js';
import type { TutorialExecution, TutorialSession, TutorialStage } from '../shared/tutorial.js';
import { formatSources } from '../shared/agent-work.js';
import { estimatedSize } from '../shared/card-size.js';
import { arrangeCanvas } from '../shared/layout.js';
import { canvasAfter, quoted } from './agent-tools.js';
import { projectFolderRoot, type ProjectFolders } from './project-folders.js';
import { Store, StoreError } from './store.js';
import { loadTutorialContent } from './tutorial-content.js';
import type { ImportArtifact } from './tutorial.js';
import { ArtifactEditingService } from './artifact-editing.js';

type Source = { n: number; title: string; url: string; page?: string; snippet: string };
type Direction = { id: string; title: string; why: string; queries: string[]; sources: Source[]; result: string };
type Page = { id: string; title: string; url: string; text: string; captured: string };
type Finding = { id: string; direction: string; page: string; claim: string; quote: string; why: string };
type Research = {
  title: string; idea: { title: string; text: string }; agent: { title: string; text: string }; directions: Direction[]; pages: Page[]; findings: Finding[];
  themes: { id: string; title: string; description: string; members: string[] }[]; aside: { finding: string; reason: string }[]; conclusion: { title: string; text: string };
};
/** What the demo keeps about a project: how far it got, and which block and artifact each part of the research became. */
export type WorkflowSession = { projectId: string; scenario: 'workflow'; step: number; createdAt: string; nodes: Record<string, string>; artifacts: Record<string, string> };

const TITLE = 'Demo · AI in Dutch business';
const source = (path: string) => fileURLToPath(new URL(`../../examples/demo-workflow/${path}`, import.meta.url));
const FILES = { data: 'data/CBS AI use by company size 2024.csv', code: 'code/AI use by company size.py', notebook: 'notebooks/Explore the turnover gap.ipynb', report: 'report.md' };
const RECORDED = 'Recorded for this demo on 11 October 2026 while it was prepared; no live search.';
const AI_USE = 'Drafted with an AI assistant (Claude) while this demo was prepared, from the findings and calculations on this canvas.';
const NOTICE = 'Recorded walk-through: the searches and pages were captured on 11 October 2026 and the calculations are saved sandbox results, so Next makes no live calls.';
const STEPS: { label: string; title: string; summary: string; live: string; next?: string }[] = [
  { label: 'Idea', title: 'Start from an idea', next: 'Plan and search the web',
    summary: 'A project starts as a rough question on the canvas: how is AI changing Dutch businesses, and what does that mean for a bank such as ABN AMRO?',
    live: 'Write your own question as a note, or bring it to the assistant.' },
  { label: 'Search', title: 'Search widely', next: 'Read the best pages',
    summary: 'An agent takes the idea on. It plans six directions, runs eight web searches and writes a Result note for each direction that cites the pages it found.',
    live: 'In a live run Claude Code does this inside ros.ai with Tavily, and nothing is searched until you approve its plan.' },
  { label: 'Read', title: 'Read deeper', next: 'Group the findings',
    summary: 'The agent reads the eleven most useful pages in full and saves twelve Findings. Each one quotes its page word for word, and ros.ai checks every quote against the saved page.',
    live: 'Open a Finding to see the quote, why it matters and where it comes from.' },
  { label: 'Group', title: 'Group and conclude', next: 'Test it with data',
    summary: 'The findings fall into three themes, and two weak ones are set aside, not deleted. Together the themes support one leading conclusion: AI use rises with company size, and readiness lags behind.',
    live: 'In a live run the agent proposes this grouping and you accept or change it.' },
  { label: 'Test', title: 'Test with data', next: 'Explore and chart',
    summary: 'The size gap is tested on CBS\'s own table. The Code block checks the data and calculates a 41.4-point gap in AI use between the smallest and the largest firms.',
    live: 'Open the Code block and press Run: it calculates again in a sandbox on this computer.' },
  { label: 'Charts', title: 'Explore and visualise', next: 'Write the report',
    summary: 'A notebook digs into what the code leaves open: where AI users hold more turnover than their share of firms. The charts from both sit on the canvas as Figures.',
    live: 'Open the notebook and run a cell to calculate it again.' },
  { label: 'Report', title: 'The final result',
    summary: 'The report brings the work together: what the sources say, the calculated figures and what the evidence does not show. Every source and figure in it links to the saved page or result.',
    live: 'Download it as a self-contained HTML file to share, with its AI-use statement.' },
];
export const WORKFLOW_STEPS = STEPS.length;
const now = () => new Date().toISOString();

let loaded: Research | undefined;
/** The recorded research, checked once: every finding quotes its page word for word, as an agent's findings must. */
function research(): Research {
  if (loaded) return loaded;
  const value = JSON.parse(readFileSync(source('research.json'), 'utf8')) as Research, pages = new Set(value.pages.map(page => page.id));
  for (const finding of value.findings) {
    const page = value.pages.find(item => item.id === finding.page);
    if (!page || !quoted(page.text, finding.quote) || !value.directions.some(direction => direction.id === finding.direction)) throw new StoreError(`The demo's finding "${finding.claim}" does not quote its page.`, 500);
  }
  if (value.directions.some(direction => direction.sources.some(item => item.page && !pages.has(item.page)))) throw new StoreError('A demo search names a page that was not read.', 500);
  return loaded = value;
}

/** The guided demo: one question taken from an idea to a report in seven steps, in a project folder like any other.
 * Each step adds its blocks and relationships and lays the demo's blocks out again as a tree read left to right.
 * Searches and pages were recorded while the demo was prepared and the calculations are saved sandbox results, all
 * labelled as such, so advancing makes no model, search or code calls. Every block stays live and editable. */
export class WorkflowTutorial {
  constructor(private store: Store, private folders: ProjectFolders, private importArtifacts: (projectId: string, nodeId: string, artifacts: ImportArtifact[], request: string) => Artifact[]) {}

  create(): string {
    const content = research();
    // A fresh folder each time: one that does not exist yet and that no other project, even a trashed one, still claims.
    const first = this.folders.suggest(TITLE).path;
    const target = Array.from({ length: 100 }, (_, index) => index ? `${first} ${index + 1}` : first)
      .find(path => { if (existsSync(path)) return false; try { this.folders.prepare(path); return true; } catch { return false; } });
    if (!target) throw new StoreError('Could not find a free folder for the demo. Remove older demo folders and try again.', 409);
    const project = this.store.createProject(TITLE);
    try { this.folders.attach(project.id, target); } catch (error) { this.store.trashProject(project.id); throw error; }
    return this.store.atomic(() => {
      const session: WorkflowSession = { projectId: project.id, scenario: 'workflow', step: 0, createdAt: now(), nodes: {}, artifacts: {} };
      this.step(session, [{ type: 'addNode', node: this.node(session, 'idea', { title: content.idea.title, description: content.idea.text, kind: 'topic', blockType: 'note' }) }], 'Demo: the idea');
      this.store.addMessage(project.id, null, 'system', 'This demo builds the canvas in seven steps as you press Next in the demo guide. The web searches and pages were recorded on 11 October 2026 while the demo was prepared, and the calculations are saved results from ros.ai\'s sandbox. Next makes no model, search or code calls. Every block stays editable, and Run calculates again.');
      this.save(session);
      return project.id;
    });
  }

  read(session: WorkflowSession, execution: TutorialExecution): TutorialSession {
    const content = research(), live = new Set(this.store.getProject(session.projectId).canvas.nodes.map(node => node.id));
    const id = (key: string) => { const value = session.nodes[key]; return value && live.has(value) ? [value] : []; };
    const directions = content.directions.map(direction => direction.id), figures = ['figure:adoption', 'figure:denominator', 'figure:gap'];
    const frames = [['idea'], ['agent', ...directions.map(key => `result:${key}`)],
      [...directions.map(key => `result:${key}`), ...content.findings.map(finding => `finding:${finding.id}`)],
      [...content.themes.map(theme => `group:${theme.id}`), 'group:aside', 'conclusion'], ['conclusion', 'dataset', 'code'],
      ['dataset', 'code', 'notebook', ...figures], [...figures, 'report']];
    const opens = [[['Open the idea', 'idea']], [['Open the agent', 'agent'], ['Open a result', `result:${directions[0]}`]],
      [['Open a finding', 'finding:measure-cbs'], ['Pages the agent read', 'agent']], [['Open the conclusion', 'conclusion'], ['Open a theme', 'group:measure']],
      [['Open the code', 'code'], ['Open the data', 'dataset']], [['Open the notebook', 'notebook'], ['Open a chart', 'figure:gap']], [['Open the report', 'report']]];
    const stages: TutorialStage[] = STEPS.map((step, index) => {
      const done = index <= session.step, frame = done ? frames[index].flatMap(id) : [];
      return { index, title: step.title, nodeId: frame[0] ?? null, summary: step.summary, status: done ? 'completed' : 'pending', label: step.label, live: step.live, next: step.next, frame,
        open: done ? opens[index].flatMap(([label, key]) => id(key).map(nodeId => ({ label, nodeId }))) : [] };
    });
    return { projectId: session.projectId, scenario: 'workflow', title: content.title, step: session.step, stages, runId: null, preview: null, outputArtifactIds: [], freshOutputArtifactIds: [],
      draftNodeId: session.nodes.report ?? null, draftArtifactId: null, execution, notice: NOTICE, createdAt: session.createdAt };
  }

  /** Adds the next step's blocks. */
  advance(session: WorkflowSession): void {
    if (session.step >= STEPS.length - 1) return;
    const content = research(), { projectId } = session, step = session.step + 1;
    const need = (key: string) => {
      const node = this.store.getProject(projectId).canvas.nodes.find(item => item.id === session.nodes[key]);
      if (!node) throw new StoreError('A block the next step builds on is no longer on the canvas. Undo its removal, or start the demo again.', 409);
      return node;
    };
    this.store.atomic(() => {
      if (step === 1) {
        const idea = need('idea'), agent = this.node(session, 'agent', { title: content.agent.title, description: content.agent.text, kind: 'activity', blockType: 'agent', agent: { runtime: 'claude', turnId: randomUUID() } });
        const operations: Mutation[] = [{ type: 'addNode', node: agent }, this.link(idea.id, agent.id, 'taken on by')];
        for (const direction of content.directions) {
          const cited = new Set([...direction.result.matchAll(/\[(\d+)\]/gu)].map(match => Number(match[1])));
          const result = this.node(session, `result:${direction.id}`, { title: `Found: ${direction.title}`, description: `${direction.result}\n\n${formatSources(direction.sources.filter(item => cited.has(item.n)))}`, kind: 'topic', blockType: 'note', label: 'result' });
          operations.push({ type: 'addNode', node: result }, this.link(agent.id, result.id, direction.why));
        }
        this.step(session, operations, 'Demo: the agent searches the web in six directions');
        for (const direction of content.directions) this.importArtifacts(projectId, session.nodes[`result:${direction.id}`], direction.sources.map(item => ({
          kind: 'source', title: item.title, url: item.url, content: item.snippet, capture: 'search-snippet', sourceId: `S${item.n}`,
          metadata: { tutorialOrigin: 'recorded', provenance: `${RECORDED} Titles and addresses as the search returned them; for a page that was read, the excerpt is a passage from it.` },
        })), `Recorded web search: ${direction.queries.join(' · ')}`);
      } else if (step === 2) {
        const agent = need('agent');
        const pages = this.importArtifacts(projectId, agent.id, content.pages.map(page => ({
          kind: 'source', title: page.title, url: page.url, content: page.text,
          metadata: { tutorialOrigin: 'recorded', provenance: `Page text as read on ${page.captured === '2026-10-11' ? '11 October 2026' : '23 September 2026'} while the demo was prepared.` },
        })), 'Recorded page reads: the pages the agent read in full');
        content.pages.forEach((page, index) => { session.artifacts[`page:${page.id}`] = pages[index].id; });
        const operations: Mutation[] = [];
        for (const finding of content.findings) {
          const page = content.pages.find(item => item.id === finding.page)!, result = need(`result:${finding.direction}`);
          const card = this.node(session, `finding:${finding.id}`, { title: finding.claim, kind: 'topic', blockType: 'finding',
            description: `> ${finding.quote}\n\n**Why it matters:** ${finding.why}\n\n${formatSources([{ n: 1, title: page.title, url: page.url }])}` });
          operations.push({ type: 'addNode', node: card }, this.link(result.id, card.id, 'finding'));
        }
        this.step(session, operations, 'Demo: the agent saves twelve findings from the pages it read');
      } else if (step === 3) {
        const operations: Mutation[] = [], findings = new Map(content.findings.map(finding => [finding.id, finding]));
        const conclusion = this.node(session, 'conclusion', { title: content.conclusion.title, description: content.conclusion.text, kind: 'topic', blockType: 'note' });
        const group = (key: string, title: string, description: string, members: string[]) => {
          const node = this.node(session, key, { title, description, kind: 'group' });
          operations.push({ type: 'addNode', node }, ...members.map((member, index) => ({ type: 'updateNode' as const, id: need(`finding:${member}`).id, patch: { parentId: node.id, x: 0, y: index } })));
          return node;
        };
        const themes = content.themes.map(theme => group(`group:${theme.id}`, theme.title, theme.description, theme.members));
        group('group:aside', 'Set aside', `Weak or off-topic for this question. Nothing is deleted; drag a block out to use it.\n\n${content.aside.map(item => `- **${findings.get(item.finding)!.claim}:** ${item.reason}`).join('\n')}`, content.aside.map(item => item.finding));
        operations.push({ type: 'addNode', node: conclusion }, ...themes.map(theme => this.link(theme.id, conclusion.id, 'supports')));
        this.step(session, operations, 'Demo: group the findings into themes and a leading conclusion');
      } else if (step === 4) {
        const conclusion = need('conclusion'), dataset = this.addFile(session, 'dataset', FILES.data), code = this.addFile(session, 'code', FILES.code);
        const data = dataset.artifactId ? this.store.getArtifact(dataset.artifactId) : undefined;
        if (!data || !code.code) throw new StoreError('The demo could not read its data and code from the project folder.', 500);
        session.artifacts.dataset = data.id;
        this.step(session, [{ type: 'updateNode', id: code.id, patch: { code: { ...code.code, inputArtifactId: data.id } } }, this.link(conclusion.id, dataset.id, 'tested on'), this.link(dataset.id, code.id, 'input')], 'Demo: test the size gap on CBS data');
        this.store.addInput(projectId, code.id, data.id);
        const saved = loadTutorialContent('banking').reference;
        const outputs = this.importArtifacts(projectId, code.id, saved.outputs.map(output => ({
          kind: output.kind, title: output.title, content: output.content, mediaType: output.mediaType,
          metadata: { tutorialOrigin: 'saved', originalExecution: output.provenance, provenance: saved.provenance },
        })), 'Import the saved outputs of this code\'s Docker run on 23 September 2026');
        const output = (title: string) => { const found = outputs.find(item => item.title === title); if (!found) throw new StoreError(`The demo's saved result “${title}” is missing.`, 500); return found.id; };
        session.artifacts['plot:adoption'] = output('AI adoption by company size · CBS 2024');
        session.artifacts['plot:denominator'] = output('Challenge the denominator · adoption versus turnover');
        session.artifacts['metric:gap'] = output('Largest–smallest size gap · percentage points');
      } else if (step === 5) {
        const dataset = need('dataset'), code = need('code'), notebook = this.addFile(session, 'notebook', FILES.notebook);
        const cells = (JSON.parse(readFileSync(source(FILES.notebook), 'utf8')) as { cells: { outputs?: { data?: Record<string, string | string[]> }[] }[] }).cells;
        const png = cells.flatMap(cell => cell.outputs ?? []).map(output => output.data?.['image/png']).find(Boolean);
        if (!png) throw new StoreError('The demo notebook has no chart.', 500);
        const [chart] = this.importArtifacts(projectId, notebook.id, [{ kind: 'plot', title: 'Where AI users hold more turnover than their numbers', content: (Array.isArray(png) ? png.join('') : png).replace(/\s+/gu, ''), mediaType: 'image/png',
          metadata: { tutorialOrigin: 'saved', contentEncoding: 'base64', provenance: 'Output of the notebook\'s chart cell, run in ros.ai\'s Python sandbox on 11 October 2026.' } }], 'Import the chart from the notebook\'s saved run');
        session.artifacts['plot:gap'] = chart.id;
        const figure = (key: string, from: CanvasNode) => {
          const artifact = this.store.getArtifact(session.artifacts[`plot:${key}`]), node = this.node(session, `figure:${key}`, { title: artifact.title, description: '', kind: 'topic', blockType: 'figure', artifactId: artifact.id });
          return [{ type: 'addNode' as const, node }, this.link(from.id, node.id, 'plotted')];
        };
        this.step(session, [this.link(dataset.id, notebook.id, 'input'), ...figure('adoption', code), ...figure('denominator', code), ...figure('gap', notebook)], 'Demo: explore the data in a notebook and chart it');
      } else {
        const figures = ['adoption', 'denominator', 'gap'].map(key => need(`figure:${key}`));
        const [, title, template] = /^# (.+)\n+([\s\S]*)$/u.exec(readFileSync(source(FILES.report), 'utf8'))!;
        const text = template.replace(/\{\{([a-z]+(?::[a-z-]+)?)\}\}/gu, (_match, key: string) => {
          const value = session.artifacts[key];
          if (!value) throw new StoreError(`The demo report refers to “${key}”, which this project does not have.`, 500);
          return value;
        });
        // Saved as any report is, citing the exact pages and results it links; the folder then gets its file.
        const evidenceIds = [...new Set([...text.matchAll(/\(artifact:([\w-]+)\)/gu)].map(match => match[1]))];
        const { nodeId } = new ArtifactEditingService(this.store).saveReport(projectId, { title, text, evidenceIds, aiUse: AI_USE });
        session.nodes.report = nodeId;
        this.step(session, figures.map(figure => this.link(figure.id, nodeId, 'in the report')), 'Demo: write the report');
      }
      session.step = step;
      this.save(session);
    });
  }

  private save(session: WorkflowSession) { this.store.saveRecord('demo-session', session.projectId, session.projectId, session); }

  private node(session: WorkflowSession, key: string, value: Omit<CanvasNode, 'id' | 'x' | 'y' | 'parentId'>): CanvasNode {
    const node: CanvasNode = { id: randomUUID(), parentId: null, x: 0, y: 0, ...value };
    session.nodes[key] = node.id;
    return node;
  }

  private link(source: string, target: string, label: string): Mutation { return { type: 'addConnection', connection: { id: randomUUID(), source, target, label } }; }

  /** Copies one of the demo's files into the project folder and adds it as a block, as Add from the folder does. */
  private addFile(session: WorkflowSession, key: string, path: string): CanvasNode {
    const root = projectFolderRoot(this.store, session.projectId);
    if (!root) throw new StoreError('The demo\'s project folder is missing. Reconnect it, or start the demo again.', 409);
    const target = join(root, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source(path), target);
    const { nodeId } = this.folders.add(session.projectId, path);
    session.nodes[key] = nodeId;
    return this.store.getProject(session.projectId).canvas.nodes.find(node => node.id === nodeId)!;
  }

  /** One undoable change: the step's blocks and relationships, with the demo's blocks laid out again as a tree that
   * keeps the idea where it is. Blocks keep the order the research gives them; other blocks stay where they are. */
  private step(session: WorkflowSession, operations: Mutation[], label: string) {
    const canvas = canvasAfter(this.store.getProject(session.projectId).canvas, operations), order = new Map(Object.values(session.nodes).map((id, index) => [id, index]));
    const nodes = canvas.nodes.filter(node => order.has(node.id)).map(node => ({ ...node, x: 0, y: order.get(node.id)! }));
    const tree = { nodes, connections: canvas.connections.filter(edge => order.has(edge.source) && order.has(edge.target)) };
    const laid = arrangeCanvas(tree, { nodeSizes: Object.fromEntries(nodes.map(node => [node.id, estimatedSize(tree, node)])) }).canvas.nodes;
    const idea = canvas.nodes.find(node => node.id === session.nodes.idea), at = idea && laid.find(node => node.id === idea.id);
    const shift = idea && at ? { x: idea.x - at.x, y: idea.y - at.y } : { x: 0, y: 0 };
    // Adding a block finds it a free spot, so new blocks always get their place in the tree back.
    const added = new Set(operations.flatMap(operation => operation.type === 'addNode' ? [operation.node.id] : []));
    const moves: Mutation[] = laid.flatMap(node => {
      const to = node.parentId ? { x: node.x, y: node.y } : { x: node.x + shift.x, y: node.y + shift.y }, from = canvas.nodes.find(item => item.id === node.id)!;
      return added.has(node.id) || from.x !== to.x || from.y !== to.y ? [{ type: 'updateNode' as const, id: node.id, patch: to }] : [];
    });
    this.store.mutate(session.projectId, [...operations, ...moves], label);
  }
}
