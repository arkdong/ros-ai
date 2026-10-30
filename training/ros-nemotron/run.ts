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
 *   smoke      the whole path offline with a scripted teacher; spends nothing
 * Round 2's structure family (structure.ts): when, what to group and what to link after an agent's turn
 *   structure-maps     teacher writes well-organised maps          --per-domain=8 --eval-per-domain=3 --concurrency=6 --max-usd=2
 *   structure-check-links  teacher checks each map's links once more   --max-usd=1
 *   structure-label-links  teacher labels each kept pair's word and direction afresh   --max-usd=1
 *   structure-export   takes their shape away, writes structure/ and the round 2 sets (round 1 + structure); --all-links skips the check
 *   structure-eval     scores a model on the held-out maps         --student-url=... --label=x, or --model=rules|teacher
 *   structure-smoke    the structure path offline on a hand-written map; spends nothing */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { ExecutionService } from '../../src/server/execution.js';
import { ExperimentService } from '../../src/server/experiments.js';
import { AgentWorkspaceTools } from '../../src/server/agent-tools.js';
import { AGENT_LOOP_INSTRUCTIONS } from '../../src/server/agent-prompt.js';
import type { ModelAdapter } from '../../src/server/providers.js';
import { Ledger, dataDir, flag, appendJsonl, arg, path, pool, readJson, readJsonl, student, teacher, writeJson, type ChatAdapter } from './lib.js';
import { rollout, type Fixture, type Task, type Trajectory } from './env.js';
import { FAMILIES } from './families.js';
import { EVAL_DOMAINS, TRAIN_DOMAINS, makeProjects, makeTasks, seeded } from './generate.js';
import { web } from './world.js';
import { check } from './check.js';
import { isValidation, toSample } from './export.js';
import { scriptedTeacher, scriptedWeb } from './smoke.js';
import { SMOKE_MAP, answerFor, askFor, checkLinks, evaluate, keptLinks, labelLinks, makeCases, makeMap, mapKey, scoreCase, summarise, toStructureSample, uniqueMaps, type LinkCheck, type LinkLabels, type StructureCase, type StructureMap } from './structure.js';
import { landingPlan } from '../../src/server/ros-layer.js';
import { LINK_WORDS } from '../../src/shared/links.js';

const step = process.argv[2];
const files = {
  snapshot: () => path('snapshot.json'), fixtures: () => path('fixtures.jsonl'), evalFixtures: () => path('eval-fixtures.jsonl'),
  tasks: () => path('tasks.jsonl'), evalTasks: () => path('eval-tasks.jsonl'), trajectories: () => path('trajectories.jsonl'),
  maps: () => path('structure', 'maps.jsonl'), evalMaps: () => path('structure', 'eval-maps.jsonl'), evalCases: () => path('structure', 'eval-cases.jsonl'),
  linkChecks: () => path('structure', 'link-checks.jsonl'), linkLabels: () => path('structure', 'link-labels.jsonl'),
};
/** A map's cases come from a seed of its own, so every export takes the same shape away. */
const casesOf = (map: StructureMap) => makeCases(map, seeded(parseInt(createHash('md5').update(map.id).digest('hex').slice(0, 8), 16)));

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
const ALWAYS = 'Before EVERY tool call, write one short sentence saying why (never send a tool call with empty text). Use exact IDs from the selection or from tool results; never make up an ID. A block\'s text in the selection needs no ros_read_selected call; call it with an artifactId only when that ID is listed. Selected blocks arrive with their text; read any other block you rely on with ros_read_canvas first. A tool may only change selected blocks or blocks this turn created; if asked to change or delete others, say which blocks to select instead. Keep the final answer under 120 words.';
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
    // No research-declined task: since #95 a search plan starts without asking, so the app has nothing to decline.
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
} else if (step === 'structure-maps') {
  const ledger = new Ledger(Number(arg('max-usd', '2'))), model = teacher(ledger, 'structure-maps', false);
  let failing = 0;
  for (const [domains, file, count] of [[TRAIN_DOMAINS, files.maps(), Number(arg('per-domain', '8'))], [EVAL_DOMAINS, files.evalMaps(), Number(arg('eval-per-domain', '3'))]] as const) {
    const written = readJsonl<StructureMap>(file), seen = new Set(written.map(mapKey));
    // A domain's maps one after another, so each request knows the titles before it, and domains side by side. Every map
    // is saved as it comes; one that fails is left for the next run, which writes only what is missing.
    await pool(domains, Number(arg('concurrency', '6')), async domain => {
      const titles = written.filter(map => map.domain === domain).map(map => map.title);
      for (let index = titles.length, tries = 0; titles.length < count && tries < count * 2; index++, tries++) {
        const map = await makeMap(model, domain, index, titles).catch(error => {
          const message = (error as Error).message;
          if (message.startsWith('Spend cap')) throw error;
          if (++failing >= 5) throw new Error(`Five maps in a row failed, so the run stops. Last: ${message}`);
          console.warn(`maps: ${domain}: ${message.slice(0, 200)}`);
          return null;
        });
        if (!map) continue;
        failing = 0;
        if (seen.has(mapKey(map))) continue;
        seen.add(mapKey(map)); appendJsonl(file, map); titles.push(map.title);
      }
      console.log(`maps: ${domain} (${titles.length} of ${count})`);
    });
  }
  console.log(`${readJsonl(files.maps()).length} training maps, ${readJsonl(files.evalMaps()).length} evaluation maps. Spent US$${ledger.spentUsd.toFixed(3)} in total.`);
} else if (step === 'structure-check-links') {
  const ledger = new Ledger(Number(arg('max-usd', '1'))), model = teacher(ledger, 'structure-check-links', false);
  const done = new Set(readJsonl<LinkCheck>(files.linkChecks()).map(check => check.mapId));
  const todo = [...readJsonl<StructureMap>(files.maps()), ...readJsonl<StructureMap>(files.evalMaps())].filter(map => map.links.length && !done.has(map.id));
  await pool(todo, Number(arg('concurrency', '6')), async map => {
    const check = await checkLinks(model, map).catch(error => { if ((error as Error).message.startsWith('Spend cap')) throw error; console.warn(`${map.id}: ${(error as Error).message.slice(0, 200)}`); return null; });
    if (check) appendJsonl(files.linkChecks(), check);
  });
  const links = readJsonl<LinkCheck>(files.linkChecks()).flatMap(check => check.links);
  console.table(LINK_WORDS.map(word => ({ word, links: links.filter(link => link.word === word).length, kept: links.filter(link => link.word === word && link.keep).length })));
  console.log(`${links.filter(link => link.keep).length} of ${links.length} links kept${todo.length ? '' : ' (nothing left to check)'}. Spent US$${ledger.spentUsd.toFixed(3)} in total.`);
} else if (step === 'structure-label-links') {
  const ledger = new Ledger(Number(arg('max-usd', '1'))), model = teacher(ledger, 'structure-label-links', false);
  const checks = new Map(readJsonl<LinkCheck>(files.linkChecks()).map(check => [check.mapId, check]));
  const kept = [...readJsonl<StructureMap>(files.maps()), ...readJsonl<StructureMap>(files.evalMaps())].map(map => keptLinks(map, checks.get(map.id)));
  const done = new Set(readJsonl<LinkLabels>(files.linkLabels()).map(labels => labels.mapId));
  await pool(kept.filter(map => map.links.length && !done.has(map.id)), Number(arg('concurrency', '6')), async map => {
    const labels = await labelLinks(model, map).catch(error => { if ((error as Error).message.startsWith('Spend cap')) throw error; console.warn(`${map.id}: ${(error as Error).message.slice(0, 200)}`); return null; });
    if (labels) appendJsonl(files.linkLabels(), labels);
  });
  const labelled = new Map(readJsonl<LinkLabels>(files.linkLabels()).map(labels => [labels.mapId, labels.links])), count = { unchanged: 0, otherWord: 0, turned: 0, dropped: 0 };
  for (const map of kept) for (const link of map.links) {
    const now = labelled.get(map.id)?.find(item => [item.from, item.to].sort().join('\u0000') === [link.from, link.to].sort().join('\u0000'));
    if (!labelled.has(map.id)) continue;
    count[!now ? 'dropped' : now.from !== link.from ? 'turned' : now.word !== link.word ? 'otherWord' : 'unchanged']++;
  }
  console.log(`${labelled.size} maps labelled; their kept links: ${JSON.stringify(count)}. Spent US$${ledger.spentUsd.toFixed(3)} in total.`);
} else if (step === 'structure-export') {
  // The links a check dropped stay out, and labelled maps take their labelled links, unless --all-links asks for the maps as written.
  const checks = new Map(readJsonl<LinkCheck>(files.linkChecks()).map(check => [check.mapId, check])), labels = new Map(readJsonl<LinkLabels>(files.linkLabels()).map(item => [item.mapId, item.links]));
  const read = (file: string) => uniqueMaps(readJsonl<StructureMap>(file)).map(map => flag('all-links') ? map : labels.has(map.id) ? { ...map, links: labels.get(map.id)! } : keptLinks(map, checks.get(map.id)));
  const cases = read(files.maps()).flatMap(casesOf), held = read(files.evalMaps()).flatMap(casesOf);
  const rows = cases.flatMap(item => { const sample = toStructureSample(item); return sample ? [{ item, sample }] : []; });
  for (const [split, keep] of [['train', false], ['val', true]] as const) writeFileSync(path('structure', `${split}.jsonl`), rows.filter(({ item }) => isValidation(item.mapId) === keep).map(({ sample }) => JSON.stringify(sample)).join('\n') + '\n');
  writeFileSync(files.evalCases(), held.map(item => JSON.stringify(item)).join('\n') + '\n');
  // Round 2 trains on round 1's turns and the structure family together, so Local ROS keeps working as an agent too.
  for (const split of ['train', 'val']) {
    const round1 = existsSync(path(`${split}.jsonl`)) ? readFileSync(path(`${split}.jsonl`), 'utf8').trim() : '';
    writeFileSync(path('round2', `${split}.jsonl`), [round1, readFileSync(path('structure', `${split}.jsonl`), 'utf8').trim()].filter(Boolean).join('\n') + '\n');
  }
  console.table([...new Set(rows.map(({ item }) => item.kind))].map(kind => ({ kind, samples: rows.filter(({ item }) => item.kind === kind).length })));
  console.log(`${rows.length} structure samples (${cases.length - rows.length} cut from the packet), ${held.length} evaluation cases. Round 2 sets in ${dataDir()}/round2/.`);
} else if (step === 'structure-eval') {
  const label = arg('label', 'baseline')!, cases = readJsonl<StructureCase>(files.evalCases());
  if (!cases.length) throw new Error('Run structure-export first.');
  const model = arg('model') === 'rules' ? 'rules' : arg('model') === 'teacher' ? teacher(new Ledger(Number(arg('max-usd', '3'))), 'structure-eval', false) : student();
  const summary = await evaluate(cases, model, path('structure', 'eval', `${label}.jsonl`), Number(arg('concurrency', '2')));
  writeJson(path('structure', 'eval', `${label}.summary.json`), { at: new Date().toISOString(), label, ...summary });
  console.log(`${label}: ${JSON.stringify(summary, null, 2)}`);
} else if (step === 'structure-smoke') {
  process.env.ROS_TRAINING_DATA ??= mkdtempSync(join(tmpdir(), 'ros-structure-smoke-'));
  const cases = makeCases(SMOKE_MAP, seeded(7)), samples = cases.map(toStructureSample).filter(Boolean);
  // The original shape, read back by the app's own parser, has to score full marks; ros.ai's own rules show the floor.
  const original = summarise(cases.map(item => { const { view, asked } = askFor(item); return scoreCase(item, landingPlan(JSON.stringify(answerFor(item.target, asked)), asked, view, item.request)); }));
  const rules = await evaluate(cases, 'rules', path('structure', 'eval', 'smoke-rules.jsonl'));
  console.log(`${cases.length} cases (${[...new Set(cases.map(item => item.kind))].join(', ')}), ${samples.length} samples in ${dataDir()}`);
  console.log(`original shape: ${JSON.stringify(original)}\nros.ai's rules: ${JSON.stringify(rules)}`);
  if (samples.length !== cases.length || original.group.f1 !== 1 || original.link.f1 !== 1 || original.leftAlone !== 1) process.exitCode = 1;
} else {
  console.log('Steps: snapshot, projects, tasks, rollout, report, export, eval, smoke, structure-maps, structure-export, structure-eval, structure-smoke. See README.md.');
}
