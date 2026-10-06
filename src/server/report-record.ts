import { evidenceClaim, type AiUseCall, type ClaimType, type RecordVersion, type ReportAttempt, type ReportDecision, type ReportEvidence, type ReportRecord } from '../shared/reports.js';
import { outputFreshness } from '../shared/output-provenance.js';
import type { Artifact, ProjectDetail, Run } from '../shared/types.js';
import { usageProject } from './budget-report.js';
import type { Store } from './store.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bytes = (value: unknown) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const json = (content: string | undefined) => { try { return object(JSON.parse(content ?? '')); } catch { return {}; } };
/** Exports keep file names, never the folders they came from. URLs are left intact. */
export const withoutPaths = (value: string) => value.replace(/(?<![\w:/.])(?:[A-Za-z]:\\|\/)(?:[^\s"'\\/:]+[\\/])+([^\s"'\\/:]+)/gu, '$1');
const version = (artifact: Artifact): RecordVersion => ({ id: artifact.id, title: withoutPaths(artifact.title), kind: artifact.kind, hash: artifact.hash });

function lineage(artifact: Artifact, byId: Map<string, Artifact>): Artifact[] {
  const chain = [artifact];
  for (let current = artifact; typeof current.metadata?.sourceArtifactId === 'string';) {
    const source = byId.get(current.metadata.sourceArtifactId);
    if (!source || chain.includes(source)) break;
    chain.push(source); current = source;
  }
  return chain;
}

/** The last traceback line and the program line it points at. Docker programs run as /input/program.py. */
function failure(run: Run, log: Artifact | undefined): string | null {
  if (!['failed', 'interrupted'].includes(run.status)) return null;
  const parsed = json(log?.content), stderr = typeof parsed.stderr === 'string' ? parsed.stderr : '', start = stderr.lastIndexOf('Traceback (most recent call last):');
  const lines = start < 0 ? [] : stderr.slice(start).split('\n').map(line => line.trimEnd()).filter(line => line.trim() && !/^\s*[~^]+\s*$/u.test(line));
  const frame = lines.findLastIndex(line => /^\s*File "\/input\/program\.py", line \d+/u.test(line)), source = frame >= 0 ? lines[frame + 1] : undefined;
  const at = frame >= 0 ? `program line ${/line (\d+)/u.exec(lines[frame])![1]}${source && !/^\s*File "/u.test(source) ? `: ${source.trim()}` : ''}` : '';
  const last = lines.at(-1)?.trim() || (typeof parsed.error === 'string' ? parsed.error : '') || run.error || '';
  const text = [last, at].filter(Boolean).join(' at ');
  return text ? withoutPaths(text).slice(0, 600) : null;
}

function codeOrigin(run: Run, runs: Map<string, Run>): string | null {
  const config = run.configuration, plan = object(config.originPlan);
  if (config.manualCode) return 'Saved Code block. ros.ai did not generate this program.';
  if (typeof plan.runId === 'string') { const source = runs.get(plan.runId); return `From a saved ${source ? `${source.provider} ${source.model} ` : ''}plan${plan.codeChanged ? ', edited before running' : ', run unchanged'}.`; }
  return typeof config.planner === 'string' ? withoutPaths(config.planner) : null;
}

function attempts(detail: ProjectDetail, blocks: Set<string>, cited: Set<string>): { attempts: ReportAttempt[]; notRun: number } {
  const byId = new Map(detail.artifacts.map(artifact => [artifact.id, artifact])), runs = new Map(detail.runs.map(run => [run.id, run]));
  const tried = detail.runs.filter(run => run.configuration.kind === 'local-experiment' && blocks.has(run.nodeId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const numbers = new Map<string, number>();
  const result = tried.filter(run => run.startedAt).map(run => {
    const config = run.configuration, number = (numbers.get(run.nodeId) ?? 0) + 1;
    numbers.set(run.nodeId, number);
    const artifacts = run.artifactIds.map(id => byId.get(id)).filter((artifact): artifact is Artifact => Boolean(artifact));
    const program = artifacts.find(artifact => artifact.kind === 'code'), log = artifacts.find(artifact => artifact.kind === 'log');
    const input = (typeof config.sourceDatasetArtifactId === 'string' ? byId.get(config.sourceDatasetArtifactId) : undefined) ?? artifacts.find(artifact => artifact.kind === 'dataset' && artifact.metadata?.executionRole === 'input');
    const capabilities = object(config.capabilities), sandbox = object(config.backend === 'nebius-sandbox' ? capabilities.nebiusSandbox : capabilities.sandbox), approval = object(config.approval);
    const runtime = json(log?.content).runtime ?? sandbox.runtime ?? capabilities.runtime;
    const freshness = config.manualCode && program ? outputFreshness(program, detail).state : null;
    return {
      runId: run.id, block: withoutPaths(detail.project.canvas.nodes.find(node => node.id === run.nodeId)?.title ?? run.node.title), number, status: run.status,
      startedAt: run.startedAt ?? null, endedAt: run.endedAt ?? null,
      backend: config.backend === 'docker-python' ? 'isolated Python in Docker, no network' : config.backend === 'nebius-sandbox' ? 'Nebius remote sandbox' : 'bounded local Python',
      program: program ? version(program) : null, input: input ? version(input) : null, parameters: object(config.parameters),
      runtime: typeof runtime === 'string' ? runtime : null, image: config.backend === 'docker-python' && typeof sandbox.imageId === 'string' ? sandbox.imageId : null,
      approval: typeof approval.status === 'string' ? withoutPaths(`${approval.status}${typeof approval.decisionReason === 'string' ? ` · ${approval.decisionReason}` : ''}`) : null,
      failure: failure(run, log), codeOrigin: codeOrigin(run, runs), codeNow: freshness === 'current' ? 'same' as const : freshness === 'stale' ? 'changed' as const : null,
      outputs: artifacts.filter(artifact => !['code', 'log'].includes(artifact.kind) && artifact.metadata?.executionRole !== 'input').map(artifact => ({ ...version(artifact), cited: cited.has(artifact.id) })),
    };
  });
  return { attempts: result, notRun: tried.length - result.length };
}

function decisions(detail: ProjectDetail): ReportDecision[] {
  const byId = new Map(detail.artifacts.map(artifact => [artifact.id, artifact]));
  return detail.project.canvas.nodes.flatMap(node => (node.decisions ?? []).map(decision => ({
    id: decision.id, block: withoutPaths(node.title), text: decision.text, reason: decision.reason, at: decision.at, withdrawnAt: decision.withdrawnAt ?? null,
    basedOn: decision.basedOn.map(basis => { const artifact = byId.get(basis.artifactId); return artifact?.hash === basis.hash ? version(artifact) : { id: basis.artifactId, hash: basis.hash, missing: true as const }; }),
  }))).sort((a, b) => a.at.localeCompare(b.at));
}

/** Rows come from usage records, so a plan run that shares its assistant turn's request counts once.
 * Codex keeps its own login and sends no usage row; each submitted Codex turn is one entry. */
function aiCalls(store: Store, detail: ProjectDetail, includeRequests: boolean): { calls: AiUseCall[]; unattributed: number } {
  const projectId = detail.project.id, runs = new Map(detail.runs.map(run => [run.id, run]));
  const block = (runId?: string) => { const run = runId ? runs.get(runId) : undefined; return run ? withoutPaths(detail.project.canvas.nodes.find(node => node.id === run.nodeId)?.title ?? run.node.title) : null; };
  const rows = store.listUsage().map(row => ({ row, owner: usageProject(store, row) }));
  const calls: AiUseCall[] = rows.filter(({ owner }) => owner === projectId).map(({ row }) => {
    const trace = object(row.reportedUsage), search = row.provider === 'tavily', messages = object(trace.request).messages, query = typeof trace.query === 'string' ? trace.query : null;
    const request = Array.isArray(messages) ? messages.map(message => ({ role: String(object(message).role), content: withoutPaths(String(object(message).content)) })) : query ? [{ role: 'search query', content: withoutPaths(query) }] : [];
    return {
      id: row.id, at: row.createdAt, kind: search ? 'search' as const : 'model' as const,
      service: search ? 'Tavily' : typeof trace.processingDestination === 'string' ? trace.processingDestination : row.provider === 'openai' ? 'OpenAI' : row.provider === 'nebius' ? 'Nebius' : row.provider,
      model: !search && typeof trace.model === 'string' ? trace.model : null, purpose: row.purpose,
      location: trace.processingLocation === 'local-unverified' ? 'local-unverified' as const : 'external' as const,
      outcome: row.status === 'settled' ? (trace.failure ? 'failed' : 'completed') : row.status === 'uncertain' ? 'outcome uncertain' : 'not settled',
      block: block(row.runId), contextBytes: request.length ? bytes(Array.isArray(messages) ? messages : query) : null,
      ...(includeRequests ? { request } : {}),
    };
  });
  for (const attempt of store.records<{ id: string; at: string; status: string; turnId?: string; request?: unknown }>('agent-attempt', projectId)) {
    if (!attempt.turnId && attempt.status === 'failed') continue;
    const input = object(attempt.request).input, text = Array.isArray(input) ? input.map(item => String(object(item).text ?? '')).join('\n') : '';
    calls.push({ id: attempt.id, at: attempt.at, kind: 'agent', service: 'Codex', model: null, purpose: 'Codex agent turn', location: 'external', outcome: attempt.status === 'uncertain' ? 'outcome uncertain' : attempt.status, block: null, contextBytes: text ? bytes(text) : null, ...(includeRequests ? { request: text ? [{ role: 'user', content: withoutPaths(text) }] : [] } : {}) });
  }
  return { calls: calls.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)), unattributed: rows.filter(({ owner }) => !owner).length };
}

/** Read-only. Built at export time from saved records; credentials are never part of them. */
export function reportRecord(store: Store, report: Artifact, evidence: Artifact[], includeRequests: boolean, now = new Date()): ReportRecord {
  const detail = store.detail(report.projectId), byId = new Map(detail.artifacts.map(artifact => [artifact.id, artifact])), runs = new Map(detail.runs.map(run => [run.id, run]));
  const chains = new Map(evidence.map(artifact => [artifact.id, lineage(artifact, byId)]));
  const sources = [...chains.values()].flat();
  const tried = attempts(detail, new Set(sources.map(artifact => artifact.nodeId)), new Set(sources.map(artifact => artifact.id)));
  const producedBy = Object.fromEntries(evidence.flatMap(artifact => { const runId = chains.get(artifact.id)!.map(item => item.runId).find(id => tried.attempts.some(attempt => attempt.runId === id)); return runId ? [[artifact.id, runId]] : []; }));
  const manifest = Array.isArray(report.metadata?.evidence) ? report.metadata.evidence as Partial<ReportEvidence>[] : [];
  const savedLabels: Record<string, ClaimType> = Object.fromEntries(manifest.flatMap(item => typeof item?.artifactId === 'string' && typeof item.claimType === 'string' ? [[item.artifactId, item.claimType]] : []));
  const plannedCode = detail.runs.filter(run => run.configuration.kind === 'local-experiment' && run.startedAt && object(run.configuration.originPlan).runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(run => `${withoutPaths(detail.project.canvas.nodes.find(node => node.id === run.nodeId)?.title ?? run.node.title)} · ${run.startedAt!.slice(0, 10)}: ${codeOrigin(run, runs)}`);
  const statement = typeof report.metadata?.aiUse === 'string' && report.metadata.aiUse.trim() ? report.metadata.aiUse.trim() : null;
  return {
    generatedAt: now.toISOString(), ...tried, producedBy, savedLabels, decisions: decisions(detail),
    aiUse: { ...aiCalls(store, detail, includeRequests), plannedCode, modelEvidence: evidence.filter(artifact => evidenceClaim(artifact) === 'model claim').length, statement, requestsIncluded: includeRequests },
  };
}
