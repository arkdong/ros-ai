/**
 * The AISO Research recruitment run in one command (docs/evals/aiso-research-recruitment.md).
 *
 *   npm run eval:aiso                 sync applicants from Notion, then take each one stage further
 *   npm run eval:aiso -- --sync-only  only bring new and changed applicants in from Notion
 *   npm run eval:aiso -- --port 4330 --stages 3
 *
 * Everything lives in ~/ros-ai-evals/aiso-research (or ROS_EVAL_HOME): the ros.ai data folder,
 * the project folder with one note per applicant and their CV files, and a log per run. Running it
 * again keeps the project: new applicants are added, changed ones updated, and everyone moves on
 * from the stage they reached. Keys and allowances come from ~/.config/ros.ai/keys.env.
 *
 * The Notion side is read only, except one summary that Ros asks to write to the private
 * "ros.ai eval sandbox" page at the end, which waits for Accept in the browser.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotionApi } from '../src/server/notion.js';
import { loadLocalKeys } from '../src/server/local-keys.js';
import { safeFileBase } from '../src/server/project-folders.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = resolve(process.env.ROS_EVAL_HOME || join(homedir(), 'ros-ai-evals', 'aiso-research'));
const PROJECT_TITLE = 'AISO Research recruitment';
const TURN_WAIT_MS = 25 * 60_000;
type Config = { applicants: string; team: string; teamProperties: string[]; roles: string; templates: string[]; interviews: string; sandbox: string };
const defaults: Config = {
  applicants: 'AISO Recruitment', team: 'Research', teamProperties: ['Teams', 'Position'],
  roles: 'AISO Open Positions', templates: ['Candidate Assessment', 'Interview Scoring Grid'], interviews: 'Interviews | Management', sandbox: 'ros.ai eval sandbox',
};

let port = 4330, syncOnly = false, maxStages = 6;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--sync-only') syncOnly = true;
  else if (args[i] === '--stages') maxStages = Number(args[++i]);
  else fail(`Unknown option ${args[i]}. Use --sync-only, --stages <n> or --port <n>.`);
}
function fail(message: string): never { console.error(`\n  ${message}\n`); process.exit(1); }

// Paths, config and the run log.
const projectDir = join(home, 'project'), dataDir = join(home, 'data'), statePath = join(home, 'sync-state.json'), configPath = join(home, 'config.json');
const run = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const runDir = join(home, 'runs', run), logPath = join(runDir, 'log.md');
for (const dir of [projectDir, join(projectDir, 'applicants'), dataDir, runDir]) mkdirSync(dir, { recursive: true });
if (!existsSync(configPath)) writeFileSync(configPath, `${JSON.stringify(defaults, null, 2)}\n`);
const config: Config = { ...defaults, ...JSON.parse(readFileSync(configPath, 'utf8')) };
const log = (line = '') => { appendFileSync(logPath, `${line}\n`); console.log(line ? `  ${line}` : ''); };
const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim() || 'unknown';
writeFileSync(logPath, `# Run ${run}\n\nBuild: ${commit}   Config: ${configPath}\n\n`);

loadLocalKeys();
const notion = new NotionApi(() => process.env.NOTION_TOKEN);
if (!notion.configured) fail('Notion is not connected. Add NOTION_TOKEN=... to ~/.config/ros.ai/keys.env (see the eval doc, Setup 2).');

// 1. Applicants from Notion into the project folder: one note per applicant, plus their files.
type Synced = Record<string, { file: string; lastEdited?: string }>;
const state: Synced = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const NOTION_MARK = '## From Notion';
async function findDatabase(name: string) {
  if (/[0-9a-f]{32}/i.test(name.replace(/-/g, ''))) return name;
  const found = (await notion.search(name, 'database', 10)).results.find((item: { title: string }) => item.title.trim().toLowerCase() === name.trim().toLowerCase());
  if (!found) fail(`Notion has no database called "${name}" shared with ros.ai. Share it with the integration (••• → Connections), or put its link in ${configPath}.`);
  return found.id as string;
}
const shown = (value: unknown) => Array.isArray(value) ? value.join(', ') : value === null || value === undefined || value === '' ? '' : String(value);
async function sync() {
  const database = await findDatabase(config.applicants), team = config.team.toLowerCase();
  type Row = { id: string; url?: string; title: string; lastEdited?: string; properties: Record<string, unknown> };
  const rows: Row[] = [];
  for (let cursor: string | undefined, first = true; first || cursor; first = false) {
    const page = await notion.query(database, undefined, undefined, 50, cursor);
    rows.push(...page.rows); cursor = page.nextCursor ?? undefined;
  }
  const ours = rows.filter((row: Row) => config.teamProperties.some(name => shown(row.properties[name]).toLowerCase().includes(team)));
  const added: string[] = [], updated: string[] = [];
  for (const row of ours) {
    const known = state[row.id];
    if (known && known.lastEdited === row.lastEdited) continue;
    const name = safeFileBase(row.title || `Applicant ${row.id.slice(0, 8)}`), file = known?.file ?? uniqueFile(`applicants/${name}.md`);
    const page = await notion.read(row.id, undefined);
    const fromNotion = [`${NOTION_MARK} (read ${new Date().toISOString().slice(0, 10)})`, '',
      ...Object.entries(row.properties).flatMap(([key, value]) => shown(value) ? [`- **${key}:** ${shown(value)}`] : []), '',
      ...(page.kind === 'page' && page.content ? ['### Application', '', page.content] : [])].join('\n');
    const files: string[] = [];
    for (const attachment of await notion.attachments(row.id)) {
      const target = `applicants/${name} - ${safeFileBase(attachment.name.replace(/\.[a-z0-9]+$/i, ''))}${(attachment.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase()}`;
      if (existsSync(join(projectDir, target)) || files.includes(target)) { files.push(target); continue; }
      try {
        const response = await fetch(attachment.url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        writeFileSync(join(projectDir, target), Buffer.from(await response.arrayBuffer()));
        files.push(target);
      } catch (error) { log(`Could not download ${attachment.name} for ${name}: ${error instanceof Error ? error.message : error}`); }
    }
    const path = join(projectDir, file);
    if (known && existsSync(path)) {
      // Keep everything ros.ai and the agents wrote above the Notion section; only that section is replaced.
      const current = readFileSync(path, 'utf8'), at = current.indexOf(NOTION_MARK);
      writeFileSync(path, `${(at >= 0 ? current.slice(0, at) : `${current.trimEnd()}\n\n`)}${fromNotion}\n`);
      updated.push(name);
    } else {
      writeFileSync(path, `Stage: 1 Intake done\nNotion: ${row.url ?? row.id}\n${files.length ? `Files: ${files.map(item => item.replace('applicants/', '')).join(', ')}\n` : ''}\n${fromNotion}\n`.slice(0, 19_000));
      added.push(name);
    }
    state[row.id] = { file, lastEdited: row.lastEdited };
  }
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  log(`Notion: ${ours.length} ${config.team} applicants of ${rows.length} rows; ${added.length} new${added.length ? ` (${added.join(', ')})` : ''}, ${updated.length} updated.`);
}
function uniqueFile(wanted: string) {
  const dot = wanted.lastIndexOf('.'), stem = wanted.slice(0, dot), extension = wanted.slice(dot);
  for (let n = 1; ; n++) { const candidate = n === 1 ? wanted : `${stem} ${n}${extension}`; if (!existsSync(join(projectDir, candidate))) return candidate; }
}

// 2. ros.ai itself, on this checkout, with the eval's own data folder.
const url = `http://127.0.0.1:${port}`;
let server: ChildProcess | undefined;
async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(`${url}${path}`, { method: init?.method ?? (init?.body ? 'POST' : 'GET'), headers: init?.body ? { 'Content-Type': 'application/json' } : undefined, body: init?.body ? JSON.stringify(init.body) : undefined });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${payload.error ?? `HTTP ${response.status}`}`);
  return payload as T;
}
async function start() {
  try { if ((await fetch(`${url}/api/health`)).ok) fail(`Something already runs on port ${port}. Stop it or pass --port.`); } catch { /* free */ }
  server = spawn(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), 'src/server/index.ts'], {
    cwd: root, stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, ROS_DEV: '1', ROS_PORT: String(port), ROS_DATA_DIR: dataDir, ROS_CLAUDE_TURN_USD: process.env.ROS_CLAUDE_TURN_USD ?? '2' },
  });
  server.on('exit', code => { if (!stopping) fail(`ros.ai stopped (exit ${code}). See the messages above.`); });
  for (const deadline = Date.now() + 120_000; ; await new Promise(done => setTimeout(done, 500))) {
    if (Date.now() > deadline) fail('ros.ai did not start within two minutes.');
    try { if ((await fetch(`${url}/api/health`)).ok) break; } catch { /* starting */ }
  }
}
let stopping = false;
const stop = () => { stopping = true; server?.kill('SIGINT'); };
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stop(); process.exit(130); });

async function ready() {
  const problems: string[] = [];
  const credentials = (await api<{ credentials: { provider: string; configured: boolean }[] }>('/api/connections/credentials')).credentials;
  for (const [provider, key] of [['claude', 'ANTHROPIC_API_KEY'], ['tavily', 'TAVILY_API_KEY']]) if (!credentials.find(item => item.provider === provider)?.configured) problems.push(`${key} is missing from ~/.config/ros.ai/keys.env.`);
  const check = await api<{ verified: boolean | null; checkMessage: string | null }>('/api/plugins/notion/check', { body: {} });
  if (!check.verified) problems.push(`Notion: ${check.checkMessage ?? 'the secret was not accepted.'}`);
  const budgets = (await api<{ budgets: { provider: string; ready: boolean; remainingUsd: number }[] }>('/api/connections/budgets')).budgets;
  for (const provider of ['claude', 'tavily']) { const budget = budgets.find(item => item.provider === provider); if (!budget?.ready) problems.push(`No ${provider} allowance left in this data folder. Set ROS_START_ALLOWANCE_${provider.toUpperCase()}_USD in the keys file for a new one, or raise it on the Budget page.`); else log(`${provider} allowance left: US$${budget.remainingUsd.toFixed(2)}`); }
  if (problems.length) { stop(); fail(problems.join('\n  ')); }
}

async function project() {
  const projects = await api<{ id: string; title: string }[]>('/api/projects');
  let found = projects.find(item => item.title === PROJECT_TITLE);
  if (!found) found = await api('/api/projects', { body: { title: PROJECT_TITLE, folder: projectDir } });
  const id = found!.id;
  const folder = await api<{ attached: boolean }>(`/api/projects/${id}/folder`);
  if (!folder.attached) await api(`/api/projects/${id}/folder`, { body: { path: projectDir } });
  // Unattended: canvas changes and searches run within the allowances; Notion writes still wait for Accept.
  await api(`/api/projects/${id}/policy`, { method: 'PUT', body: { mode: 'full' } });
  await api(`/api/projects/${id}/assistant/backend`, { body: { backend: 'claude' } });
  return id;
}

async function placeNewFiles(projectId: string) {
  // The folder is watched; give it a moment to list what sync wrote.
  await new Promise(done => setTimeout(done, 2500));
  const status = await api<{ unplaced: { path: string; kind: string }[] }>(`/api/projects/${projectId}/folder`);
  for (const file of status.unplaced) {
    try { await api(`/api/projects/${projectId}/folder/add`, { body: { path: file.path } }); }
    catch (error) { log(`Could not add ${file.path}: ${error instanceof Error ? error.message : error}`); }
  }
}

type Turn = { id: string; status: string; reply: string; error?: string; actions: { status: string; title: string }[] };
async function ask(projectId: string, message: string, nodeId: string | null, label: string) {
  const startedAt = Date.now();
  const before = await api<{ turns: Turn[] }>(`/api/projects/${projectId}/assistant`);
  const known = new Set(before.turns.map(turn => turn.id));
  await api(`/api/projects/${projectId}/assistant/messages`, { body: { message, focus: { nodeId } } });
  let turn: Turn | undefined;
  for (const deadline = Date.now() + TURN_WAIT_MS; ; await new Promise(done => setTimeout(done, 3000))) {
    const now = await api<{ turns: Turn[] }>(`/api/projects/${projectId}/assistant`);
    turn = now.turns.find(item => !known.has(item.id));
    if (turn && turn.status !== 'running') break;
    if (Date.now() > deadline) { if (turn) await api(`/api/projects/${projectId}/assistant/turns/${turn.id}/cancel`, { body: {} }).catch(() => undefined); break; }
  }
  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
  log(`### ${label}`);
  log(`${turn?.status ?? 'no turn'} after ${minutes} min${turn?.error ? `: ${turn.error}` : ''}`);
  if (turn?.reply && turn.reply !== turn.error) log(`\n${turn.reply.trim().slice(0, 1500)}\n`);
  return turn;
}

const RULES = `Rules: use only what the applicant gave (their Notion application, CV and the links in them) and their professional work; never search or keep anything about private life, family, health, religion or politics. Quote word for word. Never repeat email addresses or phone numbers. Do not write to Notion. Agents draft, people decide: never state a hiring decision as made.`;
const stagePrompt = (title: string, nodeId: string) => `Take applicant "${title}" (block ${nodeId}) to their next recruitment stage, and only that stage.

Read their block with ros_read_canvas: its first line "Stage: <n> ..." says the last stage done, and its "Files:" line names their CV notes on the map (titled "<name> - <file>.pdf"). The Candidate Assessment and Interview Scoring Grid templates and the role texts are in Notion: find them with ros_notion_search ("${config.templates.join('", "')}", "${config.roles}") and read them with ros_notion_read.

- After 1 Intake, do 2 Screening: add one note "Assessment: ${title}" linked from their block, with exactly the Candidate Assessment template's headings, every claim quoting the application or CV.
- After 2, do 3 Background research: run ros_fan_out_search on their professional background, with the links they gave as named links in a direction; read the useful pages and save findings. Then add a note "Claim check: ${title}" linked from their block that marks each claim of their assessment confirmed, contradicted or not found, citing findings (not found is not false).
- After 3, do 4 Interview 1 preparation: add a note "Interview 1 questions: ${title}" with at most 8 questions on their actual claims and gaps, covering the four grid criteria.
- After 4, do 5 Interview 1 record: look in the Notion database "${config.interviews}" for this applicant. If there are interview notes, add a draft Interview Scoring Grid with evidence quoted from them. If not, set the stage to "5 Interview 1 not reached" and stop.

Finish by changing the first line of their block to the stage you completed, for example "Stage: 2 Screening done". ${RULES}`;
const closingPrompt = `Stages 6 and 7 for the ${config.team} team. Read the map with ros_read_canvas. For each role applied to, compare the applicants who reached stage 4 or further against the role text in Notion ("${config.roles}"), using only their accepted notes: name disagreements between screening and interview evidence rather than averaging them. Then add one note per role titled "Board brief: <role>" with ros_propose_canvas: who to consider for an offer and why, open concerns, who is not recommended and why, each statement naming the note it rests on. Then ask to write a one-paragraph summary per role to the Notion page "${config.sandbox}" with ros_notion_write (it waits for the person's Accept). ${RULES}`;

// 3. The run.
await sync();
await start();
await ready();
const projectId = await project();
await placeNewFiles(projectId);
console.log(`\n  ros.ai is open at ${url} (project "${PROJECT_TITLE}"). Watch the canvas while Ros works.\n`);
if (!syncOnly) {
  const applicants = () => api<{ project: { canvas: { nodes: { id: string; title: string; description: string; blockType?: string }[] } } }>(`/api/projects/${projectId}`)
    .then(detail => detail.project.canvas.nodes.filter(node => /^Stage:\s*\d/m.test(node.description.split('\n')[0] ?? '') && /^Notion:/m.test(node.description)));
  const stageOf = (description: string) => Number(description.match(/^Stage:\s*(\d)/)?.[1] ?? 0);
  const notReached = (description: string) => /^Stage:.*not reached/i.test(description);
  let failures = 0;
  const halt = (turn?: Turn) => { failures = turn?.status === 'completed' ? 0 : failures + 1; return failures >= 2; };
  rounds: for (let round = 0; round < maxStages; round++) {
    const todo = (await applicants()).filter(node => stageOf(node.description) < 5 && !notReached(node.description));
    if (!todo.length) break;
    log(`\n## Round ${round + 1}: ${todo.length} applicant${todo.length === 1 ? '' : 's'}`);
    for (const node of todo) {
      const before = stageOf(node.description);
      const turn = await ask(projectId, stagePrompt(node.title, node.id), node.id, `${node.title}: after stage ${before}`);
      const after = (await applicants()).find(item => item.id === node.id);
      if (!after || stageOf(after.description) <= before && !notReached(after.description)) log(`Finding: the stage of ${node.title} did not move (${turn?.status ?? 'no turn'}).`);
      if (halt(turn)) { log('\nStopped: two turns in a row failed. Fix the cause above, then run again; everyone continues from their stage.'); break rounds; }
    }
  }
  if (failures < 2) { log('\n## Shortlist and brief'); await ask(projectId, closingPrompt, null, 'Stages 6 and 7'); }
  log(`\nDone. Copy the scorecard from the eval doc into ${logPath} and score the run.`);
}
console.log(`\n  Log: ${logPath}\n  ros.ai keeps running so you can review and accept. Press Ctrl+C to stop.\n`);
