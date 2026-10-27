import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Express } from 'express';
import type { TrainingRead, TrainingView } from '../shared/types.js';
import { Store, StoreError, trainingViewSchema } from './store.js';

const run = promisify(execFile);
/** Where train_lora.py writes on the GPU machine when train/ was copied to its home folder, as the README says. */
export const DEFAULT_REMOTE = '~/train/out';
/** Data is still being made while the rollout log grew this recently. */
const LIVE_MS = 3 * 60_000;
const SPLIT = '@@ros-training@@';

const expand = (folder: string) => resolve(folder.startsWith('~/') ? join(homedir(), folder.slice(2)) : folder);
const lines = (text: string) => text.split('\n').filter(line => line.trim()).flatMap(line => { try { return [JSON.parse(line) as Record<string, any>]; } catch { return []; } });
const count = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).length : undefined;

/** The run's folder is training/ros-nemotron, or a checkout that holds it. */
function dataFolder(folder: string) {
  const root = expand(folder);
  if (!isAbsolute(root) || !existsSync(root) || !statSync(root).isDirectory()) throw new StoreError(`There is no folder ${folder} on this computer.`, 404);
  for (const run of [root, join(root, 'training/ros-nemotron')]) { const data = join(run, 'data'); if (existsSync(join(data, 'spend.jsonl')) || existsSync(join(data, 'snapshot.json'))) return { root: run, data }; }
  throw new StoreError(`${folder} holds no ros-nemotron run: no data/snapshot.json or data/spend.jsonl in it.`, 422);
}

// Trajectories hold whole conversations, so a large file is read again only when it changed.
const cache = new Map<string, { key: string; value: ReturnType<typeof summarize> }>();
function summarize(file: string) {
  const best = new Map<string, { family: string; pass: boolean; seconds: number; reasons: string[] }>();
  for (const item of lines(readFileSync(file, 'utf8'))) {
    const row = { family: String(item.family), pass: Boolean(item.verdict?.pass), seconds: Number(item.seconds) || 0, reasons: Array.isArray(item.verdict?.reasons) ? item.verdict.reasons.map(String) : [] };
    // A retried task counts once: its passing run if it has one, else its latest (as run.ts report counts it).
    if (!best.get(String(item.taskId))?.pass) best.set(String(item.taskId), row);
  }
  const all = [...best.values()], families = [...new Set(all.map(item => item.family))].map(family => {
    const runs = all.filter(item => item.family === family), reasons = new Map<string, number>();
    for (const reason of runs.filter(item => !item.pass).flatMap(item => item.reasons)) { const key = reason.replace(/\d+/gu, 'N').slice(0, 80); reasons.set(key, (reasons.get(key) ?? 0) + 1); }
    const top = [...reasons].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { family, run: runs.length, kept: runs.filter(item => item.pass).length, ...(top ? { top } : {}) };
  }).sort((a, b) => b.run - a.run);
  return { run: all.length, kept: all.filter(item => item.pass).length, seconds: all.reduce((sum, item) => sum + item.seconds, 0), families };
}
function trajectories(file: string) {
  if (!existsSync(file)) return { run: 0, kept: 0, seconds: 0, families: [] };
  const stat = statSync(file), key = `${stat.size}:${stat.mtimeMs}`, hit = cache.get(file);
  if (hit?.key === key) return hit.value;
  const value = summarize(file); cache.set(file, { key, value }); return value;
}

type Files = { metrics?: string; training?: string; gguf?: { file: string; bytes: number }[] };
/** The training side: from the GPU machine over ssh when one is named, else from a copy in train/out. */
async function trainingFiles(view: TrainingView, root: string): Promise<Files & { notice?: string }> {
  if (view.host) {
    const remote = (view.remote ?? DEFAULT_REMOTE).replace(/\/$/u, '').replace(/^~\//u, '$HOME/');
    const script = `cd "${remote}" 2>/dev/null || exit 0; cat metrics.jsonl 2>/dev/null; echo ${SPLIT}; cat training.json 2>/dev/null; echo ${SPLIT}; for f in gguf/*Q4_K_M*.gguf; do [ -f "$f" ] && wc -c < "$f" && echo "$f"; done`;
    try {
      const { stdout } = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', view.host, script], { timeout: 20_000, maxBuffer: 20_000_000 });
      const [metrics = '', training = '', gguf = ''] = stdout.split(`${SPLIT}\n`), listed = gguf.split('\n').filter(Boolean);
      const models = []; for (let i = 0; i + 1 < listed.length; i += 2) models.push({ file: listed[i + 1].replace(/^gguf\//u, ''), bytes: Number(listed[i]) || 0 });
      return { metrics, training, gguf: models };
    } catch (reason) {
      const message = reason instanceof Error ? reason.message.split('\n').find(line => /ssh:|Permission|refused|timed out|resolve/iu.test(line)) ?? 'no answer' : String(reason);
      return { ...local(root), notice: `Could not reach ${view.host} over ssh (${message.slice(0, 160)}). Showing what is on this computer.` };
    }
  }
  return local(root);
}
function local(root: string): Files {
  const out = join(root, 'train/out'), read = (name: string) => existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8') : undefined;
  const dir = join(out, 'gguf'), gguf = existsSync(dir) ? readdirSync(dir).filter(name => /Q4_K_M.*\.gguf$/iu.test(name)).map(name => ({ file: name, bytes: statSync(join(dir, name)).size })) : [];
  return { metrics: read('metrics.jsonl'), training: read('training.json'), gguf };
}

function trainingPart(metrics: string | undefined, saved: string | undefined): TrainingRead['training'] {
  const rows = lines(metrics ?? ''), begin = [...rows].reverse().find(row => row.event === 'begin');
  if (!begin) return undefined;
  const after = rows.slice(rows.lastIndexOf(begin)), last = after.at(-1)!;
  const points = (key: string) => after.filter(row => typeof row[key] === 'number').map(row => ({ step: Number(row.step), value: Number(row[key]) }));
  let summary: Record<string, unknown> = {}; try { summary = saved ? JSON.parse(saved) : {}; } catch { /* written while read */ }
  const steps = after.filter(row => typeof row.step === 'number');
  return { pilot: Boolean(begin.pilot), step: Math.max(0, ...steps.map(row => Number(row.step) || 0)), maxSteps: Number(begin.max_steps) || 0, epoch: Math.max(0, ...after.map(row => Number(row.epoch) || 0)), epochs: Number(begin.epochs) || 0,
    loss: points('loss'), evalLoss: points('eval_loss'), seconds: Number(last.seconds) || 0, usdPerHour: Number(begin.usd_per_hour) || 0,
    finished: after.some(row => row.event === 'end') && (Boolean(begin.pilot) || Boolean(summary.minutes)), base: String(begin.base ?? ''), rank: Number(begin.rank) || undefined, ...(Array.isArray(begin.targets) ? { targets: begin.targets.map(String).slice(0, 20) } : {}), lr: Number(begin.lr) || undefined, samples: Number(begin.samples) || undefined };
}

export async function readTraining(view: TrainingView): Promise<TrainingRead> {
  const { root, data } = dataFolder(view.folder);
  const done = trajectories(join(data, 'trajectories.jsonl'));
  const spend = existsSync(join(data, 'spend.jsonl')) ? lines(readFileSync(join(data, 'spend.jsonl'), 'utf8')) : [];
  const log = join(data, 'trajectories.jsonl'), updated = existsSync(log) ? statSync(log).mtime : undefined;
  const files = await trainingFiles(view, root), training = trainingPart(files.metrics, files.training);
  const evalDir = join(data, 'eval');
  const evals = existsSync(evalDir) ? readdirSync(evalDir).filter(name => name.endsWith('.jsonl')).map(name => { const rows = lines(readFileSync(join(evalDir, name), 'utf8')); return { label: name.replace(/\.jsonl$/u, ''), run: rows.length, passed: rows.filter(row => row.verdict?.pass).length }; }) : [];
  const model = files.gguf?.[0], train = count(join(data, 'train.jsonl')), val = count(join(data, 'val.jsonl'));
  const making = Boolean(updated && Date.now() - updated.getTime() < LIVE_MS), learning = Boolean(training && !training.finished && !training.pilot);
  const stage = model ? 'model' : training?.finished && !training.pilot ? 'trained' : learning ? 'training' : train ? 'data-ready' : 'data';
  return {
    stage, running: stage === 'training' || (stage === 'data' && making), fetchedAt: new Date().toISOString(), ...(files.notice ? { notice: files.notice } : {}),
    data: { tasks: count(join(data, 'tasks.jsonl')) ?? 0, ...done, spentUsd: spend.reduce((sum, row) => sum + (Number(row.usd) || 0), 0), ...(train !== undefined ? { train } : {}), ...(val !== undefined ? { val } : {}), ...(updated ? { updatedAt: updated.toISOString() } : {}) },
    ...(training ? { training } : {}), evals, ...(model ? { model } : {}),
  };
}

/** A few lines an agent can read when it opens the block. */
export function trainingSummary(read: TrainingRead) {
  const { data, training } = read, gpu = training ? training.seconds / 3600 * training.usdPerHour : 0;
  return { stage: read.stage, data: `${data.kept} of ${data.run} teacher runs kept (${data.tasks} tasks); US$${data.spentUsd.toFixed(2)} spent on Token Factory${data.train !== undefined ? `; exported ${data.train} training and ${data.val ?? 0} validation samples` : ''}`,
    families: data.families.map(item => `${item.family} ${item.kept}/${item.run}${item.top ? ` (most failed: ${item.top})` : ''}`),
    ...(training ? { training: `${training.pilot ? 'Pilot, ' : ''}step ${training.step} of ${training.maxSteps}, epoch ${training.epoch.toFixed(2)} of ${training.epochs}; last loss ${training.loss.at(-1)?.value.toFixed(3) ?? 'none yet'}${training.evalLoss.length ? `, validation loss ${training.evalLoss.at(-1)!.value.toFixed(3)}` : ''}; about US$${gpu.toFixed(2)} of GPU time` } : {}),
    evals: read.evals.map(item => `${item.label}: ${item.passed}/${item.run} held-out tasks pass`), ...(read.model ? { model: `${read.model.file}, ${(read.model.bytes / 2 ** 30).toFixed(1)} GB` } : {}) };
}

export function attachTrainingRoutes(app: Express, store: Store) {
  app.get('/api/projects/:id/nodes/:nodeId/training', async (req, res) => {
    const node = store.getProject(String(req.params.id)).canvas.nodes.find(item => item.id === String(req.params.nodeId));
    if (!node?.training) throw new StoreError('This block shows no training run.', 404);
    res.json(await readTraining(node.training));
  });
  // Checks the folder (and the ssh host) before a person adds the block.
  app.post('/api/training/preview', async (req, res) => { const view = trainingViewSchema.parse(req.body); const read = await readTraining(view); res.json({ view: { ...view, folder: view.folder.trim() }, read }); });
}
