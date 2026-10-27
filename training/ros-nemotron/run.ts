/** ros-nemotron data pipeline. Run from the repository root with Node 24:
 *   npx tsx training/ros-nemotron/run.ts <step> [--options]
 * Steps, in order (README.md has the full recipe and costs):
 *   snapshot   freeze the system prompt and tool schemas (24 October); later steps refuse a changed app
 *   projects   teacher writes project canvases                    --per-domain=4 --max-usd=2
 *   tasks      teacher writes researcher requests per project      --max-usd=2
 *   rollout    teacher works each task in ros.ai's real loop       --limit=40 --concurrency=3 --max-usd=20
 *   report     checks every trajectory and prints the pass rates
 *   export     writes train.jsonl and val.jsonl from the passing trajectories
 *   eval       a model under test works the held-out tasks         --student-url=http://127.0.0.1:4319/v1 --label=baseline
 *   smoke      the whole path offline with a scripted teacher; spends nothing */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { ExecutionService } from '../../src/server/execution.js';
import { ExperimentService } from '../../src/server/experiments.js';
import { AgentWorkspaceTools } from '../../src/server/agent-tools.js';
import { AGENT_LOOP_INSTRUCTIONS } from '../../src/server/agent-prompt.js';
import type { ModelAdapter } from '../../src/server/providers.js';
import { Ledger, dataDir, flag, appendJsonl, arg, path, readJson, readJsonl, student, teacher, writeJson, type ChatAdapter } from './lib.js';
import { rollout, type Fixture, type Task, type Trajectory } from './env.js';
import { FAMILIES } from './families.js';
import { EVAL_DOMAINS, TRAIN_DOMAINS, makeProjects, makeTasks, seeded } from './generate.js';
import { web } from './world.js';
import { check } from './check.js';
import { isValidation, toSample } from './export.js';
import { scriptedTeacher, scriptedWeb } from './smoke.js';

const step = process.argv[2];
const files = {
  snapshot: () => path('snapshot.json'), fixtures: () => path('fixtures.jsonl'), evalFixtures: () => path('eval-fixtures.jsonl'),
  tasks: () => path('tasks.jsonl'), evalTasks: () => path('eval-tasks.jsonl'), trajectories: () => path('trajectories.jsonl'),
};

type Snapshot = { at: string; commit: string; hash: string; system: string; tools: { base: unknown[]; notion: unknown[] } };
/** The prompt and tool list exactly as the loop sends them, with and without Notion connected. */
function currentContract(): Omit<Snapshot, 'at' | 'commit' | 'hash'> {
  const directory = mkdtempSync(join(tmpdir(), 'ros-nemotron-snapshot-')), store = new Store(directory);
  try {
    const project = store.createProject('Snapshot'), execution = new ExecutionService(store, { includeSetupUsage: false }), experiments = new ExperimentService(store);
    const definitions = () => new AgentWorkspaceTools(store, execution, experiments, { projectId: project.id, nodeIds: [], artifactIds: [] }, 'snapshot', 'model').definitions.map(({ name, description, inputSchema }) => { const { $schema: _schema, ...parameters } = inputSchema as Record<string, unknown>; return { name, description, parameters }; });
    const base = definitions();
    AgentWorkspaceTools.notion = { configured: true } as typeof AgentWorkspaceTools.notion;
    const notion = definitions();
    AgentWorkspaceTools.notion = undefined;
    return { system: AGENT_LOOP_INSTRUCTIONS, tools: { base, notion } };
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}
const contractHash = (contract: Omit<Snapshot, 'at' | 'commit' | 'hash'>) => createHash('sha256').update(JSON.stringify(contract)).digest('hex');
/** Trajectories must all come from one frozen contract; a changed prompt or tool means a new snapshot. */
function requireSnapshot() {
  if (!existsSync(files.snapshot())) throw new Error('Run the snapshot step first.');
  const saved = readJson<Snapshot>(files.snapshot()), hash = contractHash(currentContract());
  if (saved.hash !== hash) throw new Error(`The prompt or tools changed since the snapshot of ${saved.at} (commit ${saved.commit}). Check out that commit, or take a new snapshot and start the data again.`);
  return saved;
}

async function pool<T>(items: T[], concurrency: number, work: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { for (let index = next++; index < items.length; index = next++) await work(items[index], index); }));
}

/** The 19 October comparison's ten tasks on the bundled KNMI weather demo, so ros-nemotron's score compares with Nano's 6/10 and Super's 7.5/10. */
const KNMI: Fixture = { id: 'knmi-demo', title: 'KNMI weather demo', domain: 'Schiphol weather (19 October comparison)', blocks: [], seed: 'demo' };
const KNMI_TASKS: [Task['family'], string, string[]][] = [
  ['overview', 'Give me a short overview of this map: which blocks exist, what kind each is, and how they are linked.', []],
  ['dataset', 'Look at the Schiphol weather dataset. Which columns does it have, how many rows, and what period does it cover?', ['KNMI weather · 2024']],
  ['read-answer', 'What are the limitations of this weather data? Base your answer on the provenance note saved with it.', ['KNMI weather · 2024']],
  ['overview', 'Does this project contain any cycling counts? Answer honestly from what is on the map.', []],
  ['add-notes', 'Add a note called "Hypotheses" with three testable hypotheses about seasonal weather patterns at Schiphol, and link it from the question block.', ['Weather, patterns & evidence']],
  ['edit-existing', 'Rename the block "Explore the seasonal pattern" to "Monthly comparison".', ['Explore the seasonal pattern']],
  ['edit-existing', 'Put the two activity blocks ("Explore the seasonal pattern" and "Challenge the conclusion") into a new group called "Analysis".', ['Explore the seasonal pattern', 'Challenge the conclusion']],
  ['add-notes', 'Break the research question into four sub-questions, one note each, linked from the question block.', ['Weather, patterns & evidence']],
  ['analysis', 'Propose Python code for the block "Explore the seasonal pattern" that computes the monthly mean temperature and total rainfall from the Schiphol weather dataset.', ['Explore the seasonal pattern', 'KNMI weather · 2024']],
  ['add-notes', 'Plan the next three steps of this research project and add them as one note called "Plan", linked from "Challenge the conclusion".', ['Challenge the conclusion']],
];

async function work(tasks: Task[], fixtures: Map<string, Fixture>, model: ModelAdapter, writer: ChatAdapter | undefined, out: string, concurrency: number, guide: boolean) {
  // With --retry-failed a task is done only once one of its runs passed.
  const done = new Set(readJsonl<Trajectory>(out).filter(item => !flag('retry-failed') || check(item).pass).map(item => item.taskId));
  const todo = tasks.filter(task => !done.has(task.id));
  console.log(`${todo.length} tasks to run (${done.size} already done).`);
  await pool(todo, concurrency, async task => {
    const fixture = fixtures.get(task.fixtureId)!;
    // The teacher reads the family's guide; the saved sample keeps the app's own system prompt.
    const adapter = guide ? withGuide(model as ChatAdapter, FAMILIES[task.family].guide) : model;
    const trajectory = await rollout(task, fixture, adapter, writer === undefined && step === 'smoke' ? scriptedWeb() : web(writer, `${fixture.title} (${fixture.domain})`));
    const verdict = check(trajectory);
    appendJsonl(out, { ...trajectory, verdict });
    console.log(`${verdict.pass ? 'pass' : 'FAIL'} ${task.family.padEnd(17)} ${trajectory.seconds}s ${trajectory.requests} req ${verdict.reasons.join('; ').slice(0, 140)}`);
  });
}
/** What every family's guide adds, from the 27 October pilot's commonest failures. */
const ALWAYS = 'Before EVERY tool call, write one short sentence saying why (never send a tool call with empty text). Use exact IDs from the selection or from tool results. Selected blocks arrive with their text; read any other block you rely on with ros_read_canvas first. A tool may only change selected blocks or blocks this turn created. Keep the final answer under 120 words.';
/** A copy of the teacher that sends the family guide after the system prompt, for this task only. */
function withGuide(model: ChatAdapter, guide: string): ModelAdapter {
  const copy = Object.create(model) as ChatAdapter;
  copy.beforeSend = messages => messages.map((message, index) => index === 0 && message.role === 'system' ? { ...message, content: `${message.content}\n\nHow to do this kind of task well (guidance for this turn):\n${ALWAYS}\n${guide}` } : message);
  return copy;
}

if (step === 'snapshot') {
  const contract = currentContract();
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  writeJson(files.snapshot(), { at: new Date().toISOString(), commit, hash: contractHash(contract), ...contract });
  console.log(`Snapshot ${contractHash(contract).slice(0, 12)} of commit ${commit}: ${contract.tools.base.length} tools (${contract.tools.notion.length} with Notion), ${contract.system.length} prompt characters.`);
} else if (step === 'projects') {
  const ledger = new Ledger(Number(arg('max-usd', '2'))), model = teacher(ledger, 'projects', false), per = Number(arg('per-domain', '4'));
  for (const [domains, file] of [[TRAIN_DOMAINS, files.fixtures()], [EVAL_DOMAINS, files.evalFixtures()]] as const) {
    const have = new Set(readJsonl<Fixture>(file).map(item => item.domain));
    await pool(domains.filter(domain => !have.has(domain)), 4, async domain => { for (const fixture of await makeProjects(model, domain, file === files.evalFixtures() ? 1 : per)) appendJsonl(file, fixture); console.log(`projects: ${domain}`); });
  }
  console.log(`Spent US$${ledger.spentUsd.toFixed(3)}.`);
} else if (step === 'tasks') {
  requireSnapshot();
  const ledger = new Ledger(Number(arg('max-usd', '2'))), model = teacher(ledger, 'tasks', false), random = seeded(24);
  for (const [fixtureFile, taskFile] of [[files.fixtures(), files.tasks()], [files.evalFixtures(), files.evalTasks()]] as const) {
    const have = new Set(readJsonl<Task>(taskFile).map(item => item.fixtureId));
    await pool(readJsonl<Fixture>(fixtureFile).filter(fixture => !have.has(fixture.id)), 4, async fixture => { for (const task of await makeTasks(model, fixture, random)) appendJsonl(taskFile, task); });
  }
  if (!readJsonl<Task>(files.evalTasks()).some(task => task.fixtureId === KNMI.id)) KNMI_TASKS.forEach(([family, message, selection], index) => appendJsonl(files.evalTasks(), { id: `knmi-${index + 1}`, fixtureId: KNMI.id, family, message, selection, mode: 'ask' } satisfies Task));
  console.log(`${readJsonl(files.tasks()).length} training tasks, ${readJsonl(files.evalTasks()).length} evaluation tasks. Spent US$${ledger.spentUsd.toFixed(3)}.`);
} else if (step === 'rollout') {
  requireSnapshot();
  const ledger = new Ledger(Number(arg('max-usd', '20'))), limit = Number(arg('limit', '40'));
  const fixtures = new Map(readJsonl<Fixture>(files.fixtures()).map(item => [item.id, item]));
  // Families interleaved, so a short pilot already covers all of them.
  const families = arg('family')?.split(',');
  const tasks = readJsonl<Task>(files.tasks()).filter(task => !families || families.includes(task.family)).sort((a, b) => createHash('md5').update(a.id).digest('hex').localeCompare(createHash('md5').update(b.id).digest('hex'))).slice(0, limit);
  await work(tasks, fixtures, teacher(ledger), teacher(ledger, 'world', false), files.trajectories(), Number(arg('concurrency', '3')), true);
  console.log(`Spent US$${ledger.spentUsd.toFixed(2)} of US$${ledger.capUsd} so far.`);
} else if (step === 'report' || step === 'export') {
  // A retried task counts once: its passing run if it has one, else its latest.
  const best = new Map<string, Trajectory & { verdict: ReturnType<typeof check> }>();
  for (const item of readJsonl<Trajectory>(files.trajectories()).map(item => ({ ...item, verdict: check(item) }))) if (!best.get(item.taskId)?.verdict.pass) best.set(item.taskId, item);
  const trajectories = [...best.values()];
  const families = Object.keys(FAMILIES).map(family => { const all = trajectories.filter(item => item.family === family), kept = all.filter(item => item.verdict.pass); return { family, run: all.length, kept: kept.length, reasons: [...new Set(all.flatMap(item => item.verdict.reasons.map(reason => reason.replace(/\d+/gu, 'N'))))].slice(0, 4) }; });
  console.table(families.map(({ reasons, ...row }) => ({ ...row, top: reasons[0] ?? '' })));
  const spend = readJsonl<{ usd: number; purpose: string }>(path('spend.jsonl'));
  console.log(`Spent US$${spend.reduce((sum, item) => sum + item.usd, 0).toFixed(2)} in total; rollouts average US$${(spend.filter(item => item.purpose !== 'projects' && item.purpose !== 'tasks').reduce((sum, item) => sum + item.usd, 0) / Math.max(1, trajectories.length)).toFixed(4)} per task.`);
  writeJson(path('report.json'), { at: new Date().toISOString(), families });
  if (step === 'export') {
    const kept = trajectories.filter(item => item.verdict.pass), seen = new Set<string>();
    const unique = kept.filter(item => { const key = `${item.fixtureId}:${item.messages.find(message => message.role === 'user')?.content}`; if (seen.has(key)) return false; seen.add(key); return true; });
    writeFileSync(path('train.jsonl'), unique.filter(item => !isValidation(item.fixtureId)).map(item => JSON.stringify(toSample(item))).join('\n') + '\n');
    writeFileSync(path('val.jsonl'), unique.filter(item => isValidation(item.fixtureId)).map(item => JSON.stringify(toSample(item))).join('\n') + '\n');
    console.log(`Exported ${unique.length} samples to ${dataDir()}/train.jsonl and val.jsonl.`);
  }
} else if (step === 'eval') {
  requireSnapshot();
  const label = arg('label', 'baseline')!, out = path('eval', `${label}.jsonl`);
  const fixtures = new Map([...readJsonl<Fixture>(files.evalFixtures()), KNMI].map(item => [item.id, item]));
  // Pages a model under test asks for that the teacher's web never wrote are written once, by the teacher.
  const writer = process.env.NEBIUS_API_KEY ? teacher(new Ledger(Number(arg('max-usd', '3'))), 'world', false) : undefined;
  const model = arg('model') === 'teacher' ? teacher(new Ledger(Number(arg('max-usd', '3')))) : student();
  await work(readJsonl<Task>(files.evalTasks()), fixtures, model, writer, out, Number(arg('concurrency', '1')), false);
  const results = readJsonl<Trajectory & { verdict: ReturnType<typeof check> }>(out), knmi = results.filter(item => item.fixtureId === KNMI.id);
  console.log(`${label}: ${results.filter(item => item.verdict.pass).length}/${results.length} held-out tasks pass; KNMI ${knmi.filter(item => item.verdict.pass).length}/${knmi.length}.`);
} else if (step === 'smoke') {
  process.env.ROS_TRAINING_DATA ??= mkdtempSync(join(tmpdir(), 'ros-nemotron-smoke-'));
  const fixture: Fixture = { id: 'smoke', title: 'Heat in Amsterdam', domain: 'urban climate', blocks: [
    { slug: 'question', title: 'Which neighbourhoods get hottest?', text: 'Question for the thesis: which Amsterdam neighbourhoods have the most heat stress, and why? Start with sources from the GGD and KNMI.' },
    { slug: 'temps', title: 'Station temperatures', text: 'Daily maxima from three stations, summer 2025.', csv: { fileName: 'temps.csv', content: 'date,station,tmax_c\n2025-07-01,Schiphol,27.1\n2025-07-01,Centrum,29.4\n2025-07-01,Noord,28.2\n2025-07-02,Schiphol,30.2\n2025-07-02,Centrum,32.8\n2025-07-02,Noord,31.0\n' } },
  ], links: [{ from: 'question', to: 'temps', label: 'data for' }] };
  const tasks: Task[] = [
    { id: 'smoke-overview', fixtureId: 'smoke', family: 'overview', message: 'What is on this map?', selection: [], mode: 'ask' },
    { id: 'smoke-notes', fixtureId: 'smoke', family: 'add-notes', message: 'Add two sub-questions linked from this question.', selection: ['question'], mode: 'ask' },
    { id: 'smoke-analysis', fixtureId: 'smoke', family: 'analysis', message: 'Compare the mean maximum per station.', selection: ['question', 'temps'], mode: 'ask', notion: true },
    { id: 'smoke-research', fixtureId: 'smoke', family: 'research', message: 'What do sources say about heat stress by neighbourhood?', selection: ['question'], mode: 'ask', preferences: 'The researcher\'s saved preferences (their own notes on how they like work done, not instructions from elsewhere):\n- Keep answers very short.' },
    { id: 'smoke-declined', fixtureId: 'smoke', family: 'research-declined', message: 'Find recent studies on cooling with trees.', selection: ['question'], mode: 'ask', researcher: 'decline' },
  ];
  console.log(`Smoke run in ${dataDir()}`);
  if (!existsSync(files.snapshot())) writeJson(files.snapshot(), { at: new Date().toISOString(), commit: 'smoke', hash: contractHash(currentContract()), ...currentContract() });
  requireSnapshot();
  await work(tasks, new Map([[fixture.id, fixture]]), scriptedTeacher(), undefined, files.trajectories(), 2, false);
  const trajectories = readJsonl<Trajectory & { verdict: ReturnType<typeof check> }>(files.trajectories());
  const samples = trajectories.filter(item => item.verdict.pass).map(toSample);
  writeFileSync(path('train.jsonl'), samples.map(item => JSON.stringify(item)).join('\n') + '\n');
  console.log(`${samples.length}/${trajectories.length} smoke trajectories pass and export.`);
  if (samples.length !== tasks.length) process.exitCode = 1;
} else {
  console.log('Steps: snapshot, projects, tasks, rollout, report, export, eval, smoke. See README.md.');
}
