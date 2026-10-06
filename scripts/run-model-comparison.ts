/** Real, bounded ros.ai HTTP workflow. No direct provider calls or automatic retries. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Artifact, CanvasNode, Project, ProjectDetail, Run, UsageRecord } from '../src/shared/types.js';
import type { ExperimentPreview } from '../src/shared/experiments.js';

const root = resolve('examples/model-comparison-2026-09-23');
const base = process.env.ROS_EXAMPLE_URL || 'http://127.0.0.1:4310';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw Error('This comparison requires the authorized local application.');
const configurations = {
  openai: { provider: 'openai', model: 'gpt-5.4', label: 'GPT-5.4', spendUsd: 10 },
  nemotron: { provider: 'nebius', model: 'nvidia/Nemotron-3-Ultra-550b-a55b', label: 'Nemotron 3 Ultra', spendUsd: 20 },
  kimi: { provider: 'nebius', model: 'moonshotai/Kimi-K2.7-Code', label: 'Kimi K2.7 Code', spendUsd: 10 },
} as const;
type Key = keyof typeof configurations;
type Step = { submittedAt: string; runId?: string; observedAt?: string; wallMs?: number; status?: string; error?: string };
type Receipt = { key: Key; projectId: string; datasetArtifactId: string; sourceArtifactId: string; createdAt: string; configuration: typeof configurations[Key]; csvSha256: string; sourceSha256: string; plan?: Step; recoveredPlan?: { originalRunId: string; artifactId: string; usageId: string; codeSha256: string; noAdditionalInference: true }; execute?: Step; interpret?: Step; codeReview?: { codeSha256: string; reviewedAt: string; note: string }; snapshots?: string[] };
const at = () => new Date().toISOString();
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const read = (name: string) => readFileSync(resolve(root, name), 'utf8');
const write = (name: string, value: unknown) => writeFileSync(resolve(root, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(base + path, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw Error(`${method} ${path}: ${value.error || response.status}`);
  return value as T;
}
const [command, selected] = process.argv.slice(2);
if (!['prepare', 'plan', 'execute', 'interpret', 'collect'].includes(command) || !(selected in configurations)) throw Error('Use prepare|plan|execute|interpret|collect openai|nemotron|kimi. Plan/interpret require --authorized-40usd; execute requires --approve-code=<sha256>.');
const key = selected as Key, config = configurations[key];
mkdirSync(root, { recursive: true });
const receiptFile = `${key}/receipt.json`;
mkdirSync(resolve(root, key), { recursive: true });
const save = (value: Receipt) => write(receiptFile, value);
const source = read('source-packet.md');
const csv = readFileSync('examples/dutch-ai-adoption/cbs-ai-size-2024.csv', 'utf8');

async function collect(receipt: Receipt) {
  const detail = await api<ProjectDetail>(`/api/projects/${receipt.projectId}`);
  const usage = await api<UsageRecord[]>('/api/usage');
  const ids = new Set(detail.runs.map(run => run.id));
  write(`${key}/project-evidence.json`, detail);
  write(`${key}/usage.json`, usage.filter(item => item.runId && ids.has(item.runId)));
  for (const artifact of detail.artifacts) {
    const extension = artifact.mediaType === 'image/svg+xml' ? 'svg' : artifact.mediaType === 'application/json' ? 'json' : artifact.kind === 'code' ? 'py' : 'md';
    write(`${key}/${artifact.id}.${extension}`, artifact.content);
  }
  const synthesis = detail.artifacts.find(artifact => artifact.runId === receipt.interpret?.runId && artifact.kind === 'result');
  if (synthesis) write(`${key}/draft.md`, synthesis.content);
  return detail;
}
async function waitForRun(receipt: Receipt, step: Step): Promise<Run> {
  for (let i = 0; i < 150; i++) {
    const detail = await api<ProjectDetail>(`/api/projects/${receipt.projectId}`);
    const run = detail.runs.find(item => item.id === step.runId);
    if (!run) throw Error('Submitted run missing; inspect receipt. No retry.');
    if (!['queued', 'running'].includes(run.status)) {
      step.observedAt = at(); step.wallMs = Date.now() - Date.parse(step.submittedAt); step.status = run.status; step.error = run.error; save(receipt);
      await collect(receipt);
      if (run.status !== 'completed') throw Error(`${run.status}: ${run.error || 'Inspect saved run evidence.'}`);
      return run;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw Error('Wait deadline reached; inspect the existing run. Do not submit another.');
}

if (command === 'prepare') {
  if (existsSync(resolve(root, receiptFile))) throw Error('Prepared receipt already exists; use the saved project.');
  const project = await api<Project>('/api/projects', { title: `CBS banking comparison · ${config.label}`, start: 'blank' });
  const receipt: Receipt = { key, projectId: project.id, datasetArtifactId: '', sourceArtifactId: '', createdAt: at(), configuration: config, csvSha256: sha(csv), sourceSha256: sha(source) };
  save(receipt);
  const nodes: CanvasNode[] = [
    { id: 'explore', title: '01 · Explore the banking question', description: read('question.md'), kind: 'topic', parentId: null, x: 0, y: 0 },
    { id: 'evidence', title: '02 · Gather comparable evidence', description: source, kind: 'topic', parentId: null, x: 500, y: 0 },
    { id: 'analyze', title: '03 · Analyze and challenge', description: 'A fresh model proposes Python for the same captured CBS six-row table. Exact code is reviewed before a separate real isolated Docker execution. Saved computation is distinct from the proposed explanation.', kind: 'topic', parentId: null, x: 1000, y: 0 },
    { id: 'draft', title: '04 · Draft from actual results', description: 'A fresh model call interprets its actual saved calculation and the common source-method packet. No prior prepared article is supplied. The output must distinguish observed adoption, denominator differences and hypotheses for bank conversations.', kind: 'topic', parentId: null, x: 1500, y: 0 },
    { id: 'calculation', title: 'Measure adoption and challenge the turnover denominator', description: 'Compute adoption gap between the largest and smallest covered groups; compare adopter turnover share with enterprise adoption by size; count negative differences. Six aggregate size bins are not six firms. Do not infer causal value creation.', kind: 'activity', parentId: 'analyze', x: 24, y: 140 },
    { id: 'article', title: 'Evidence-grounded banking research note', description: 'Write a concise cited research note from the selected actual Python outputs and captured CBS data/methods. Separate evidence from interpretation and untested suggestions.', kind: 'activity', parentId: 'draft', x: 24, y: 140 },
  ];
  const links = [['explore', 'evidence', 'frames evidence need'], ['evidence', 'calculation', 'provides captured data to'], ['calculation', 'article', 'provides actual findings to']];
  await api(`/api/projects/${project.id}/mutations`, { label: 'Create authorized comparison workspace and fixed research scope', operations: [...nodes.map(node => ({ type: 'addNode', node })), ...links.map(([source, target, label], i) => ({ type: 'addConnection', connection: { id: `comparison-link-${i}`, source, target, label } }))] });
  await api(`/api/projects/${project.id}/models`, { selection: { provider: config.provider, model: config.model } }, 'PATCH');
  const resource = await api<{ id: string }>(`/api/projects/${project.id}/resources`, { mode: 'copy', name: 'CBS 2024 six published size groups', fileName: 'cbs-ai-size-2024.csv', content: csv });
  const dataset = await api<Artifact>(`/api/projects/${project.id}/resources/${resource.id}/use`, { nodeId: 'evidence' });
  receipt.datasetArtifactId = dataset.id; save(receipt);
  // The current import API accepts CSV. This one-cell CSV preserves the full
  // source/method note as evidence; it is never the experiment's numerical df.
  const sourceCsv = 'source_method_note\n"' + source.replace(/"/g, '""') + '"\n';
  const packet = await api<{ id: string }>(`/api/projects/${project.id}/resources`, { mode: 'copy', name: 'CBS source and method packet · textual evidence', fileName: 'cbs-source-method-packet.csv', content: sourceCsv });
  const packetArtifact = await api<Artifact>(`/api/projects/${project.id}/resources/${packet.id}/use`, { nodeId: 'evidence' });
  receipt.sourceArtifactId = packetArtifact.id; save(receipt);
  await api(`/api/projects/${project.id}/inputs`, { nodeId: 'calculation', artifactId: packetArtifact.id });
  for (const artifactId of [dataset.id, packetArtifact.id]) await api(`/api/projects/${project.id}/inputs`, { nodeId: 'article', artifactId });
  await api(`/api/projects/${project.id}/policy`, { mode: 'ask' }, 'PUT');
  await collect(receipt);
  console.log(JSON.stringify({ key, status: 'prepared', projectId: project.id, csvSha256: receipt.csvSha256, sourceSha256: receipt.sourceSha256 }));
} else {
  const receipt = JSON.parse(read(receiptFile)) as Receipt;
  try {
    if (command === 'collect') { await collect(receipt); console.log(JSON.stringify({ key, status: 'collected', projectId: receipt.projectId })); }
    else if (command === 'plan' || command === 'interpret') {
      if (!process.argv.includes('--authorized-40usd')) throw Error('Explicit invocation of the approved US$40 comparison is required.');
      if (receipt[command]) throw Error('This inference step already has a receipt. Inspect it; do not automatically retry.');
      if (command === 'interpret') {
        if (receipt.execute?.status !== 'completed') throw Error('A real successful Docker execution is required before interpretation.');
        const detail = await collect(receipt);
        for (const artifact of detail.artifacts.filter(item => item.runId === receipt.execute!.runId && ['metric', 'table', 'result'].includes(item.kind))) await api(`/api/projects/${receipt.projectId}/inputs`, { nodeId: 'article', artifactId: artifact.id });
      }
      const step: Step = { submittedAt: at(), status: 'submitting' }; receipt[command] = step; save(receipt);
      const run = command === 'plan'
        ? await api<Run>(`/api/projects/${receipt.projectId}/nodes/calculation/experiment-plan`, { request: read('plan-prompt.md'), datasetArtifactId: receipt.datasetArtifactId, backend: 'docker-python' })
        : await api<Run>(`/api/projects/${receipt.projectId}/runs`, { nodeId: 'article', request: read('interpret-prompt.md'), useSearch: false });
      step.runId = run.id; step.status = run.status; save(receipt);
      const finished = await waitForRun(receipt, step);
      if (command === 'plan') {
        const plan = finished.configuration.experimentPlan as { code: string; parameters: Record<string, string | number | boolean>; explanation: string };
        write(`${key}/proposed-code.py`, plan.code + '\n'); write(`${key}/plan.json`, plan);
        console.log(JSON.stringify({ key, status: finished.status, runId: run.id, codeSha256: sha(plan.code), next: 'Inspect proposed-code.py, then explicitly execute --approve-code=<hash>.' }));
      } else {
        const detail = await collect(receipt);
        const artifact = detail.artifacts.find(item => item.runId === run.id && item.kind === 'result');
        if (artifact) await api(`/api/projects/${receipt.projectId}/highlights`, { nodeId: 'draft', artifactId: artifact.id, x: 24, y: 140 });
        await collect(receipt);
        console.log(JSON.stringify({ key, status: finished.status, runId: run.id, draftArtifactId: artifact?.id, elapsedMs: step.wallMs }));
      }
    } else if (command === 'execute') {
      if (receipt.execute) throw Error('Execution already has a receipt; inspect it. No automatic retry.');
      if (receipt.plan?.status !== 'completed' && !receipt.recoveredPlan) throw Error('A completed native plan or explicitly recovered settled response is required.');
      const plan = JSON.parse(read(`${key}/plan.json`));
      if (receipt.recoveredPlan && (receipt.recoveredPlan.originalRunId !== receipt.plan?.runId || receipt.recoveredPlan.codeSha256 !== sha(plan.code))) throw Error('Recovered proposal must match the original run and exact captured code.');
      const approvedHash = process.argv.find(arg => arg.startsWith('--approve-code='))?.split('=')[1];
      if (approvedHash !== sha(plan.code)) throw Error('Review the saved model proposal and pass its exact code SHA-256.');
      receipt.codeReview = { codeSha256: approvedHash, reviewedAt: at(), note: 'Coding assistant inspected exact generated code for the authorized small CSV calculation; no code edits before isolated execution. Native Ask approval remains separate from inference.' };
      receipt.execute = { submittedAt: at(), status: 'previewing' }; save(receipt);
      const recovery = receipt.recoveredPlan;
      const preview = await api<ExperimentPreview>(`/api/projects/${receipt.projectId}/experiments/preview`, { nodeId: 'calculation', request: 'Execute the inspected model proposal on the captured six CBS aggregate rows; separate exact-action approval under the user-authorized comparison.' + (recovery ? ` Exact settled response recovered after a local metadata-saving failure. Original run ${recovery.originalRunId}; proposal artifact ${recovery.artifactId}; usage ${recovery.usageId}. Original failed run remains unchanged; no extra inference or code edits.` : ''), datasetArtifactId: receipt.datasetArtifactId, backend: 'docker-python', code: plan.code, parameters: plan.parameters, ...(recovery ? {} : { planRunId: receipt.plan!.runId }) });
      receipt.execute.runId = preview.run.id; save(receipt); write(`${key}/approved-preview.json`, preview);
      if (preview.approval.status !== 'pending') throw Error('Expected native Ask approval; inspect existing preview.');
      await api(`/api/experiments/${preview.run.id}/decision`, { fingerprint: preview.approval.fingerprint, decision: 'allow' });
      const finished = await waitForRun(receipt, receipt.execute);
      const detail = await collect(receipt);
      const highlight = detail.artifacts.find(item => item.runId === finished.id && item.kind === 'plot') ?? detail.artifacts.find(item => item.runId === finished.id && item.kind === 'table');
      if (highlight) await api(`/api/projects/${receipt.projectId}/highlights`, { nodeId: 'analyze', artifactId: highlight.id, x: 24, y: 140 });
      await collect(receipt);
      console.log(JSON.stringify({ key, status: finished.status, runId: finished.id, elapsedMs: receipt.execute.wallMs }));
    }
  } catch (error) {
    const step = ['plan', 'execute', 'interpret'].includes(command) ? receipt[command as 'plan' | 'execute' | 'interpret'] : undefined;
    if (step) { step.error = error instanceof Error ? error.message : String(error); if (!step.status || ['submitting', 'previewing'].includes(step.status)) step.status = 'submission-error'; save(receipt); }
    await collect(receipt).catch(() => undefined);
    throw error;
  }
}
