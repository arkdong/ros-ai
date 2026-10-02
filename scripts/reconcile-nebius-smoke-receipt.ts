/** Read-only reconciliation of the single admitted smoke operation. It never
 * creates a remote instance, and preserves the first adapter's immutable record.
 */
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Store } from '../src/server/store.js';
import { NebiusSandboxBackend } from '../src/server/nebius-sandbox.js';
import type { RemoteExecutionState } from '../src/server/sandbox.js';

config({ path: resolve('.env.local'), quiet: true });
const store = new Store(resolve('.ros-ai'), { recoverInterrupted: false });
try {
  const authorization = 'adam-2026-09-23-single-nebius-beta-smoke';
  const admitted = store.record<{ runId: string }>('scoped-sandbox-smoke', authorization);
  if (!admitted) throw new Error('No admitted smoke operation to reconcile.');
  if (store.record('scoped-sandbox-reconciliation', authorization)) throw new Error('This receipt has already been reconciled.');
  const original = store.getRun(admitted.runId);
  const remote = store.record<{ state: RemoteExecutionState }>('remote-recovery', original.id)?.state;
  if (!remote?.operationId || remote.phase !== 'terminal') throw new Error('Known terminal operation required; no remote execution or retry is allowed.');
  const response = await fetch(`https://api.tokenfactory.nebius.com/sandboxes/v1/operations/${encodeURIComponent(remote.operationId)}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${process.env.NEBIUS_SANDBOX_API_KEY ?? process.env.NEBIUS_API_KEY}`, Project: process.env.NEBIUS_SANDBOX_PROJECT_ID ?? process.env.NEBIUS_PROJECT_ID ?? '' } });
  if (!response.ok) throw new Error(`Existing sandbox receipt returned HTTP ${response.status}.`);
  const raw = await response.text(); if (Buffer.byteLength(raw) > 2_500_000) throw new Error('Receipt exceeds 2.5 MB.');
  const operation = JSON.parse(raw);
  // Exercise the corrected production decoder against this freshly captured
  // response. The supplied transport is fully offline: no POST leaves the host.
  const decoder = new NebiusSandboxBackend({ apiKey: 'offline-capture', projectId: 'offline-capture', fetch: async (_url, request) => request?.method === 'POST'
    ? new Response(JSON.stringify({ uuid: remote.instanceId, image: operation.image_uuid }), { status: 201, headers: { Location: `/v1/operations/${remote.operationId}` } })
    : new Response(raw, { status: 200 }) });
  const result = await decoder.start({ code: original.configuration.code as string, csv: original.configuration.csv as string, parameters: {} }).done;
  if (result.status !== 'completed' || result.stdout !== 'Nebius remote smoke: sum= 15 mean= 3\n' || operation.result_image_uuid !== null) throw new Error('Captured operation did not confirm the expected successful disposable smoke.');
  const at = new Date().toISOString();
  const reconciled = store.atomic(() => {
    if (store.record('scoped-sandbox-reconciliation', authorization)) throw new Error('Receipt already reconciled.');
    const project = store.getProject(original.projectId);
    const run = store.createRun({ id: randomUUID(), projectId: original.projectId, nodeId: original.nodeId, node: project.canvas.nodes.find(node => node.id === original.nodeId)!, projectRevision: project.revision, request: 'Read and validate the already completed Nebius operation. No code was executed again.', useSearch: false, status: 'running', createdAt: at, startedAt: at, provider: 'nebius-sandbox', model: 'Existing operation receipt · read-only validation', modelVersion: null, configuration: { kind: 'remote-result-reconciliation', originalRunId: original.id, operationId: remote.operationId, remote, actualExecutionStartedAt: original.startedAt, actualExecutionEndedAt: original.endedAt, executionRequests: 0, receiptFetches: 1, explanation: 'The initial adapter misclassified no-signal sentinel -1 as a failure. Original run is preserved. This validates the same actual provider execution with the corrected production decoder.', resultImageUuid: null, disposable: true }, inputs: [], messages: [], tools: [], events: [{ at, type: 'receipt', message: 'Authenticated GET confirmed original remote SUCCESS, Python exit 0, signal -1 (no signal), worker success and no saved filesystem checkpoint.' }], artifactIds: [] });
    const artifactIds = result.outputs.map(output => store.addArtifact({ projectId: run.projectId, nodeId: run.nodeId, runId: run.id, ...output, capture: 'full-content', metadata: { originalRunId: original.id, originalOperationId: remote.operationId, capture: 'Read-only provider receipt; original remote output, not a new execution.' } }).id);
    artifactIds.push(store.addArtifact({ projectId: run.projectId, nodeId: run.nodeId, runId: run.id, kind: 'log', title: 'Authenticated terminal operation receipt', content: raw, capture: 'full-content', mediaType: 'application/json' }).id);
    artifactIds.push(store.addArtifact({ projectId: run.projectId, nodeId: run.nodeId, runId: run.id, kind: 'result', title: 'Remote execution confirmed · same original operation', content: `The original disposable Nebius sandbox really ran Python 3.12.13 and returned sum 15, mean 3, and a tiny CSV. Its process exited 0; signal -1 means no terminating signal. The first adapter incorrectly treated -1 as failure. This receipt revalidates that exact existing operation after the decoder fix. No new sandbox was submitted.\n\nActual stdout:\n${result.stdout}\nThe provider operation is terminal SUCCESS and result_image_uuid is null. Raw reported cost ${remote.rawCost} has unknown units; no USD charge or zero-cost claim is made. Provider operation logs may be retained.`, capture: 'generated', mediaType: 'text/plain' }).id);
    store.updateRun(run.id, { status: 'completed', endedAt: at, artifactIds });
    store.saveRecord('scoped-sandbox-reconciliation', authorization, run.projectId, { originalRunId: original.id, reconciliationRunId: run.id, verifiedAt: at, executionRequests: 0 });
    return run;
  });
  console.log(JSON.stringify({ projectId: original.projectId, originalRunId: original.id, reconciliationRunId: reconciled.id, operationId: remote.operationId, verified: true, remoteSubmissions: 0, rawCost: remote.rawCost, costUnit: 'unknown', savedCheckpoint: false }));
} finally { store.close(); }
