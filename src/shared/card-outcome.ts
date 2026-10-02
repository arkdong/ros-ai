import type { Artifact, CanvasNode, Run } from './types.js';
import { textPreview } from './presentation.js';
import { isOutputArtifact } from './blocks.js';

export type CardOutcome = {
  label: string;
  tone: 'neutral' | 'progress' | 'success' | 'warning' | 'danger';
  text: string;
  hasResult: boolean;
  artifactIds: string[];
  runId?: string;
};
export type CardOutcomeOptions = {
  projectId?: string;
  /** Current runtime gates, keyed by backend. An empty string clears a captured
   * blocker; an absent key falls back to the attempt's captured capabilities. */
  blockers?: Partial<Record<'bounded' | 'docker-python' | 'nebius-sandbox', string>>;
};

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const newest = <T extends { createdAt: string; id: string }>(items: T[]) => [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
const sentences = (text: string, count = 2, limit = 280) => textPreview(text.trim().split(/(?<=[.!?])\s+/u).slice(0, count).join(' '), limit).text;
function plainText(value: string) {
  return value.replace(/```[\s\S]*?```/gu, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*>]\s+)/gmu, '')
    .replace(/[`*_]/gu, '')
    // Exact references stay in the original artifact and returned provenance.
    .replace(/\s*\(artifact [a-f\d-]{36}\)/giu, '')
    .replace(/\s+/gu, ' ').trim();
}

function savedOutcome(run: Run, artifacts: Artifact[]): Pick<CardOutcome, 'text' | 'artifactIds'> | undefined {
  const outputs = artifacts.filter(a => a.runId === run.id && a.projectId === run.projectId && isOutputArtifact(a));
  if (run.configuration.kind === 'external-notebook-capture' && outputs.length) return {
    text: sentences(`Captured ${outputs.slice(0, 2).map(a => textPreview(plainText(a.title), 100).text).join(' and ')} for inspection. ros.ai did not execute these notebook cells.`),
    artifactIds: outputs.slice(0, 2).map(a => a.id),
  };
  const conclusion = newest(outputs.filter(a => a.kind === 'result')).find(a => {
    const text = a.content.trim();
    return text && !/^[{[<]/u.test(text) && !a.mediaType?.includes('json');
  });
  if (conclusion) {
    const text = sentences(plainText(conclusion.content));
    if (text) return { text, artifactIds: [conclusion.id] };
  }
  const metrics = outputs.filter(a => a.kind === 'metric').flatMap(a => {
    try {
      const parsed: unknown = JSON.parse(a.content);
      const value = record(parsed).value ?? parsed;
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return [];
      if (typeof value === 'number' && !Number.isFinite(value)) return [];
      return [{ artifact: a, text: `${textPreview(plainText(a.title), 90).text} was ${textPreview(String(value), 60).text}` }];
    } catch { return []; }
  }).slice(0, 2);
  if (metrics.length) return { text: sentences(`${metrics.map(m => m.text).join('; ')}.`), artifactIds: metrics.map(m => m.artifact.id) };
  const visual = outputs.filter(a => ['dataset', 'table', 'plot'].includes(a.kind));
  if (visual.length) return { text: sentences(`Saved ${visual.slice(0, 2).map(a => textPreview(plainText(a.title), 100).text).join(' and ')} for inspection.`), artifactIds: visual.slice(0, 2).map(a => a.id) };
  return undefined;
}

function executionBlocker(run: Run, options: CardOutcomeOptions): string | undefined {
  if (run.configuration.kind !== 'local-experiment' || run.status === 'completed' || run.status === 'running') return;
  const backend = String(run.configuration.backend ?? 'bounded');
  if (options.blockers && Object.hasOwn(options.blockers, backend)) return options.blockers[backend as keyof NonNullable<CardOutcomeOptions['blockers']>] || undefined;
  const capabilities = record(run.configuration.capabilities);
  const runtime = record(backend === 'nebius-sandbox' ? capabilities.nebiusSandbox : backend === 'docker-python' ? capabilities.sandbox : capabilities);
  const costGate = record(runtime.costGate);
  if (costGate.ready === false && typeof costGate.reason === 'string') return costGate.reason;
  if (runtime.available === false) return `${backend === 'nebius-sandbox' ? 'Nebius Sandbox' : backend === 'docker-python' ? 'Local Docker' : 'Local Python'} is unavailable; execution cannot start.`;
}

/** Display-only, deterministic evidence selection. This does not produce new
 * scientific conclusions, mutate research, or interpret metrics as causality. */
export function deriveCardOutcome(node: CanvasNode, runs: Run[], artifacts: Artifact[], options: CardOutcomeOptions = {}): CardOutcome {
  const attempts = newest(runs.filter(r => r.nodeId === node.id && (!options.projectId || r.projectId === options.projectId)));
  const nodeArtifacts = artifacts.filter(a => a.nodeId === node.id && (!options.projectId || a.projectId === options.projectId));
  const results = attempts.filter(r => r.status === 'completed').flatMap(run => {
    const outcome = savedOutcome(run, nodeArtifacts);
    return outcome ? [{ ...outcome, run }] : [];
  });
  const result = results[0];
  const latest = attempts.find(r => r.status === 'running' || r.status === 'queued') ?? attempts[0];
  const prior = (text: string) => result ? textPreview(`${sentences(plainText(text), 1, 140)} Earlier result: ${sentences(result.text, 1, 160)}`, 320).text : sentences(plainText(text));
  const state = (label: string, tone: CardOutcome['tone'], text: string): CardOutcome => ({ label, tone, text: prior(text), hasResult: !!result, artifactIds: result?.artifactIds ?? [], ...(latest ? { runId: latest.id } : {}) });

  if (latest) {
    const remote = record(latest.configuration.remote);
    if (remote.phase === 'uncertain') return state('Outcome uncertain', 'warning', 'The remote execution outcome is unconfirmed; inspect this attempt before trying again.');
    const blocker = executionBlocker(latest, options);
    if (blocker) return state('Blocked', 'warning', blocker);
    const approval = record(latest.configuration.approval);
    if (latest.status === 'running') return state('In progress', 'progress', latest.configuration.kind === 'external-notebook-capture' ? 'The external notebook capture is in progress; ros.ai is not executing its cells.' : latest.configuration.kind === 'local-experiment' ? 'The approved experiment is running; its outcome is not yet available.' : 'Research is in progress; its outcome is not yet available.');
    if (latest.status === 'queued') return approval.status === 'pending'
      ? state('Approval needed', 'warning', 'Review the saved code and inputs before this experiment can start.')
      : state('Queued', 'progress', 'This work is queued and has not finished.');
    if (latest.status === 'failed') return state('Attempt failed', 'danger', latest.error ? `The latest attempt failed: ${latest.error}` : 'The latest attempt failed; inspect its execution details.');
    if (latest.status === 'interrupted') return state('Interrupted', 'warning', latest.error ? `The latest attempt was interrupted: ${latest.error}` : 'The latest attempt was interrupted; a new review is needed to continue.');
    if (latest.status === 'cancelled') return state('Stopped', 'neutral', 'The latest attempt was stopped.');
    if (latest.configuration.purpose === 'experiment-plan' && (!result || latest.createdAt > result.run.createdAt)) return state('Plan ready', 'neutral', 'Code has been prepared for review; this plan does not establish an execution result.');
  }
  if (result) return { label: result.run.configuration.kind === 'external-notebook-capture' ? 'Captured output' : 'Saved outcome', tone: result.run.configuration.kind === 'external-notebook-capture' ? 'neutral' : 'success', text: result.text, hasResult: true, artifactIds: result.artifactIds, runId: result.run.id };
  if (latest?.status === 'completed' && latest.configuration.kind === 'external-notebook-capture') return { label: 'Notebook snapshot saved', tone: 'neutral', text: 'The external notebook snapshot is saved for inspection. No outputs have been captured, and ros.ai did not execute its cells.', hasResult: false, artifactIds: [], runId: latest.id };

  // A captured source or imported dataset is evidence, not a successful
  // experiment. Preview input copies are deliberately excluded here.
  const completed = new Map(attempts.filter(r => r.status === 'completed').map(r => [r.id, r]));
  const evidence = nodeArtifacts.filter(a => {
    const run = completed.get(a.runId);
    return run?.projectId === a.projectId && (a.kind === 'source' || a.kind === 'dataset' && run.configuration.kind === 'file-import');
  });
  if (evidence.length) {
    const datasets = evidence.filter(a => a.kind === 'dataset');
    const sources = evidence.filter(a => a.kind === 'source');
    const parts = [datasets.length ? `${datasets.length} captured dataset${datasets.length === 1 ? '' : 's'}` : '', sources.length ? `${sources.length} saved source${sources.length === 1 ? '' : 's'}${sources.some(a => a.capture === 'search-snippet') ? ' (including search excerpts)' : ''}` : ''].filter(Boolean);
    return { label: 'Evidence saved', tone: 'neutral', text: `Available for inspection: ${parts.join(' and ')}.`, hasResult: true, artifactIds: evidence.map(a => a.id), ...(latest ? { runId: latest.id } : {}) };
  }
  return { label: 'Purpose', tone: 'neutral', text: sentences(plainText(node.description || node.title), 1, 180) || 'Add a question or purpose to begin this note.', hasResult: false, artifactIds: [] };
}

/** Group summaries expose existing child evidence without importing it or
 * attributing a child's execution to its parent. */
export function deriveGroupOutcomes(nodes: CanvasNode[], runs: Run[], artifacts: Artifact[], options: CardOutcomeOptions = {}): Record<string, CardOutcome> {
  const outcomes = Object.fromEntries(nodes.map(node => [node.id, deriveCardOutcome(node, runs, artifacts, options)]));
  const summarize = (id: string, seen = new Set<string>()): CardOutcome => {
    const own = outcomes[id];
    if (own.hasResult || own.label !== 'Purpose' || seen.has(id)) return own;
    seen.add(id);
    const children = nodes.filter(node => node.parentId === id).map(node => ({node, outcome:summarize(node.id, new Set(seen))})).filter(item => item.outcome.hasResult);
    if (!children.length) return own;
    return outcomes[id] = { label:'Findings inside', tone:'success', hasResult:true,
      text:textPreview(children.slice(0,2).map(({node,outcome}) => `${node.title}: ${outcome.text}`).join(' '), 340).text,
      artifactIds:[...new Set(children.flatMap(item => item.outcome.artifactIds))] };
  };
  nodes.forEach(node => summarize(node.id));
  return outcomes;
}
