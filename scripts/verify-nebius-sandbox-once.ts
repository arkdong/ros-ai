/** One-use implementation of Adam's explicit September 23 beta smoke-test scope.
 * This is not a general experiment path or a pricing override for the product.
 * It records admission before any request, never retries a submission, and uses
 * the production bounded adapter. Normal app allowance gates remain unchanged.
 */
import { config } from 'dotenv';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Store } from '../src/server/store.js';
import { Authority } from '../src/server/authority.js';
import { NebiusSandboxBackend } from '../src/server/nebius-sandbox.js';

config({ path: resolve('.env.local'), quiet: true });
if (process.argv[2] !== '--execute-authorized-single-smoke') throw new Error('Requires the explicitly authorized one-time smoke invocation.');
const authorization = 'adam-2026-09-23-single-nebius-beta-smoke';
const store = new Store(resolve('.ros-ai'), { recoverInterrupted: false });
const backend = new NebiusSandboxBackend({ completionTimeoutMs: 45_000 });
const code = 'import statistics\nvalues = [int(row["value"]) for row in rows]\nprint("Nebius remote smoke: sum=", sum(values), "mean=", statistics.mean(values))\nmetric("Sum of 1 through 5", sum(values))\nexport_csv("Tiny remote output", [{"sum": sum(values), "mean": statistics.mean(values)}])\n';
const csv = 'value\n1\n2\n3\n4\n5\n';
const now = () => new Date().toISOString();
const fingerprint = createHash('sha256').update(JSON.stringify({ code, csv, parameters: {}, timeoutMs: 5000, image: backend.capabilities().imageId })).digest('hex');
try {
  if (!backend.capabilities().available) throw new Error('Configured Nebius sandbox key/project/image is missing. No remote request made.');
  const run = store.atomic(() => {
    if (store.record('scoped-sandbox-smoke', authorization)) throw new Error('This one-use authorization has already been admitted. No retry or new remote session is permitted.');
    const project = store.createProject('Nebius Sandbox · live verification');
    store.mutate(project.id, [{ type: 'addNode', node: { id: 'remote-smoke', kind: 'activity', title: 'Verify a real remote Python run', description: 'One explicitly authorized disposable Nebius beta sandbox. Standard-library sum and mean of the public values 1–5, with a tiny CSV output. This is execution verification, not research or a model run. Sandbox USD charge remains unknown.', x: 0, y: 0 } }], 'Prepare authorized remote verification');
    const saved = store.getProject(project.id), id = randomUUID(), at = now();
    const scope = 'Adam explicitly authorized one short Nebius beta sandbox smoke test despite unverified pricing: trivial non-sensitive standard-library calculation and tiny output; no retries, installation, inference, heavy compute or general pricing override.';
    store.saveRecord('scoped-sandbox-smoke', authorization, project.id, { runId: id, admittedAt: at, maxAttempts: 1, timeoutMs: 5000, fingerprint, scope, reservedUsd: null, estimatedUsd: null, pricing: 'Unknown; specifically waived as a blocker for this one smoke test only.' });
    const authority = new Authority(store);
    authority.configure(project.id, { mode: 'ask', scope, nodeIds: ['remote-smoke'], datasetIds: [], allowActionCreation: false, limits: { experiments: 1, modelCalls: 0, createdActions: 0, runtimeSeconds: 5, spendUsd: 0 } });
    authority.reserve(project.id, { kind: 'experiment', nodeId: 'remote-smoke', fingerprint, runtimeSeconds: 5 });
    store.saveRecord('sandbox-admission', id, project.id, { runId: id, at, reservedUsd: null, authorization, pricingBasis: 'Scoped explicit beta smoke authorization; USD reservation and charge unknown. Not a general app allowance.' });
    return store.createRun({ id, projectId: project.id, nodeId: 'remote-smoke', node: saved.canvas.nodes[0], projectRevision: saved.revision, request: scope, useSearch: false, status: 'running', createdAt: at, startedAt: at, provider: 'nebius-sandbox', model: 'Python standard library', modelVersion: null, configuration: { kind: 'scoped-sandbox-verification', backend: 'nebius-sandbox', code, csv, parameters: {}, fingerprint, timeoutMs: 5000, approval: { status: 'approved', reason: scope }, capabilities: backend.capabilities(), usdCharge: null }, inputs: [], messages: [], tools: [], events: [{ at, type: 'started', message: 'One-use explicit smoke authorization recorded before remote submission.' }], artifactIds: [] });
  });
  const artifactIds = [store.addArtifact({ projectId: run.projectId, nodeId: run.nodeId, runId: run.id, kind: 'code', title: 'Exact remote smoke program', content: code, capture: 'generated', mediaType: 'text/x-python' }).id];
  artifactIds.push(store.addArtifact({ projectId: run.projectId, nodeId: run.nodeId, runId: run.id, kind: 'dataset', title: 'Non-sensitive smoke input · integers 1–5', content: csv, capture: 'generated', mediaType: 'text/csv' }).id);
  const handle = backend.start({ code, csv, parameters: {}, timeoutMs: 5000, onProgress: state => store.saveRecord('remote-recovery', run.id, run.projectId, { state, observedAt: now(), scope: authorization }) });
  const stop = () => handle.cancel('Smoke verification interrupted; request disposable operation termination.');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const result = await handle.done;
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  for (const output of result.outputs) artifactIds.push(store.addArtifact({ projectId: run.projectId, nodeId: run.nodeId, runId: run.id, ...output, capture: 'generated', metadata: { backend: 'nebius-sandbox', operationId: result.remote?.operationId } }).id);
  artifactIds.push(store.addArtifact({ projectId: run.projectId, nodeId: run.nodeId, runId: run.id, kind: 'log', title: 'Actual Nebius execution receipt', content: JSON.stringify(result, null, 2), mediaType: 'application/json', capture: 'generated' }).id);
  const sum = result.outputs.find(output => output.title === 'Sum of 1 through 5');
  const verified = result.status === 'completed' && sum && JSON.parse(sum.content).value === 15 && result.stdout.includes('mean= 3');
  store.updateRun(run.id, { status: verified ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed', endedAt: result.endedAt, artifactIds, error: verified ? undefined : result.error ?? 'Remote result did not match the expected trivial calculation.', configuration: { ...run.configuration, remote: result.remote, runtime: result.runtime, cleanup: 'Disposable execution requested; terminal operation status is recorded. Provider log deletion is not verified.' }, cost: { reservedUsd: null, estimatedUsd: null, rawCost: result.remote?.rawCost ?? null, costUnit: 'unknown' }, events: [...run.events, { at: result.endedAt, type: verified ? 'completed' : 'failed', message: verified ? 'Actual remote Python returned expected stdout, metric and tiny CSV output.' : result.error ?? 'Verification failed; no retry.' }] });
  console.log(JSON.stringify({ projectId: run.projectId, runId: run.id, verified: Boolean(verified), status: result.status, stdout: result.stdout, outputs: result.outputs.map(({ kind, title, content }) => ({ kind, title, content })), remote: result.remote, runtime: result.runtime, startedAt: result.startedAt, endedAt: result.endedAt, error: result.error ?? null, reservedUsd: null, estimatedUsd: null }, null, 2));
  if (!verified) process.exitCode = 1;
} finally { store.close(); }
