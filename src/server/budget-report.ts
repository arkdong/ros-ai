import type { UsageAnalytics, UsageEvent } from '../shared/budget-report.js';
import type { Run, UsageRecord } from '../shared/types.js';
import type { Store } from './store.js';
import { isSearchProvider, searchLabels } from '../shared/search.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const amount = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Explicit trace ownership is strongest. Older rows have only a saved run ID. */
export function usageProject(store: Store, row: UsageRecord): string | undefined {
  const trace = object(row.reportedUsage);
  if (typeof trace.projectId === 'string' && trace.projectId) return trace.projectId;
  // Unattributed records stay outside project totals.
  const runProject = row.runId ? store.runProjectId(row.runId) : undefined;
  if (runProject) return runProject;
  if (typeof trace.assistantTurnId === 'string') {
    const turn = store.record<{ projectId: string }>('assistant-turn', trace.assistantTurnId);
    if (typeof turn?.projectId === 'string') return turn.projectId;
  }
  // Written by versions before November 2026, which kept one Nebius ceiling across projects.
  const admission = store.record<{ projectId: string }>('combined-nebius-admission', `inference-${row.id}`);
  if (typeof admission?.projectId === 'string') return admission.projectId;
  return undefined;
}

const providerNames: Record<string, string> = { nebius: 'Nebius', openai: 'OpenAI', ...searchLabels, claude: 'Claude Code', 'nebius-sandbox': 'Nebius Sandbox' };
// The work a request did, named the way the app names it.
const tasks: [RegExp, string][] = [
  [/^Continuous project assistant/, 'ROS'], [/^Project discussion/, 'Project chat'], [/^Claude Code/, 'Claude Code'], [/^Codex/, 'Codex'],
  [/^Node synthesis/, 'Block summary'], [/^Experiment code/, 'Code plan'], [/^Research collaborator/, 'Research'], [/workspace guide/i, 'Workspace guide'],
  [/search|reading|source discovery/i, 'Web search'], [/experiment/i, 'Code run'],
];
const taskName = (purpose: string) => tasks.find(([pattern]) => pattern.test(purpose))?.[1] ?? purpose;
const claudeModels: Record<string, string> = { sonnet: 'Claude Sonnet', opus: 'Claude Opus', haiku: 'Claude Haiku' };
// Catalogue ids read as names: nvidia/nemotron-3-super-120b-a12b becomes Nemotron 3 Super.
const modelName = (id: string) => { const short = id.split('/').pop()!, nemotron = /^nemotron-3-(nano|super|ultra)/i.exec(short); return nemotron ? `Nemotron 3 ${nemotron[1][0].toUpperCase()}${nemotron[1].slice(1).toLowerCase()}` : short; };

/** Every recorded request across projects, for spend by model and by task. Read-only: no prompts, responses,
 * authorization IDs or credentials. */
export function usageAnalytics(store: Store, connectionNames: Record<string, string> = {}, now = new Date()): UsageAnalytics {
  const projects = new Map([...store.listProjects(), ...store.listTrashedProjects()].map(project => [project.id, project]));
  const runs = new Map<string, Run>();
  const events: UsageEvent[] = store.usageLedger().map(row => {
    const trace = object(row.reportedUsage), response = object(trace.response), usage = object(response.usage);
    const projectId = usageProject(store, row) ?? null, project = projectId ? projects.get(projectId) : undefined;
    let run: Run | undefined;
    if (row.runId) { try { run = runs.get(row.runId) ?? store.getRun(row.runId); runs.set(row.runId, run); } catch { run = undefined; } }
    const nodeId = run?.nodeId ?? (typeof trace.nodeId === 'string' ? trace.nodeId : null);
    const search = isSearchProvider(row.provider);
    const rawModel = typeof trace.model === 'string' ? trace.model : search ? null : run?.model ?? null;
    const model = rawModel ? row.provider === 'claude' ? claudeModels[rawModel] ?? rawModel : modelName(rawModel) : search ? `${searchLabels[row.provider as keyof typeof searchLabels]} search` : null;
    return {
      id: row.id, at: row.createdAt, provider: row.provider, providerName: connectionNames[row.provider] ?? providerNames[row.provider] ?? row.provider,
      model, task: taskName(row.purpose), projectId, projectTitle: project?.title ?? null,
      nodeTitle: nodeId ? project?.canvas.nodes.find(node => node.id === nodeId)?.title ?? run?.node.title ?? null : null,
      costUsd: amount(row.estimatedUsd),
      inputTokens: !search ? amount(usage.inputTokens) : null, outputTokens: !search ? amount(usage.outputTokens) : null,
    };
  });
  return { generatedAt: now.toISOString(), events: events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) };
}
