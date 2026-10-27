import type { Canvas, CanvasNode } from './types.js';
import { ACP_AGENTS, isAcpAgent } from './acp-agents.js';

/** The words a Text block can carry as its label; the researcher's own word (at most 40 characters) is allowed too. */
export const TEXT_LABELS = ['question', 'plan', 'task', 'result', 'finding', 'decision', 'draft', 'report'] as const;

/** What a block is on screen: seven kinds plus Group. Storage keeps the older blockType and kind words as aliases
 * (note, action, report and finding are all Text; dataset is Data; figure and file are File; notion and google are External).
 * A Web block is External too, named for what it reads. */
export type KindName = 'Text' | 'Code' | 'Notebook' | 'Data' | 'File' | 'External' | 'Web' | 'Agent' | 'Group' | 'Search';
export function kindName(node: Pick<CanvasNode, 'kind' | 'blockType'>): KindName {
  if (node.kind === 'group') return 'Group';
  switch (node.blockType) {
    case 'code': return 'Code';
    case 'notebook': return 'Notebook';
    case 'dataset': return 'Data';
    case 'figure': case 'file': return 'File';
    case 'notion': case 'google': return 'External';
    case 'web': return 'Web';
    case 'agent': return 'Agent';
    case 'search': return 'Search';
    default: return 'Text';
  }
}

/** The label a Text block carries: its own, or the one its older block type implies (a Report is a report,
 * a Finding a finding, an Action a task). */
export function textLabel(node: Pick<CanvasNode, 'kind' | 'blockType' | 'label' | 'legacyKind'>): string | undefined {
  if (node.label) return node.label;
  if (node.kind === 'group') return undefined;
  switch (node.blockType) {
    case 'report': return 'report';
    case 'finding': return 'finding';
    case 'action': return 'task';
    case undefined: return node.kind === 'activity' || node.legacyKind === 'activity' ? 'task' : undefined;
    default: return undefined;
  }
}

/** The name of the agent runtime that made a block, for its provenance line. */
export function agentName(runtime: 'claude' | 'codex' | 'model' | string | undefined): string {
  return runtime === 'claude' ? 'Claude Code' : runtime === 'codex' ? 'Codex' : runtime === 'model' ? 'Ros' : isAcpAgent(runtime) ? ACP_AGENTS[runtime].label : 'Agent';
}

/** The caption of the link from a decision block to the block it rests on. */
export const DECISION_LINK = 'based on';

/** A Report or Finding block carries the label its block type implies; only a plain Text block's label changes. */
export const labelFixed = (node: Pick<CanvasNode, 'label' | 'blockType'>) => !node.label && (node.blockType === 'report' || node.blockType === 'finding');

/** The canvas edit that sets or clears a Text block's label. Clearing the task label of an older Action block
 * makes it a plain note, so the old kind no longer implies a label. */
export function labelPatch(node: Pick<CanvasNode, 'kind' | 'blockType'>, value: string): Partial<CanvasNode> {
  const label = value.trim().slice(0, 40);
  const legacyTask = !label && (node.kind === 'activity' || node.blockType === 'action');
  return { label, ...(legacyTask ? { kind: 'topic' as const, ...(node.blockType === 'action' ? { blockType: 'note' as const } : {}) } : {}) };
}

/** The agent that made a block, for its provenance line: a Result note or Web block through its link from the
 * Agent block, a finding through the note or Web block it came from. */
export function blockOrigin(canvas: Pick<Canvas, 'nodes' | 'connections'>, id: string, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  for (const edge of canvas.connections) {
    if (edge.target !== id) continue;
    const source = canvas.nodes.find(node => node.id === edge.source);
    if (!source) continue;
    if (source.blockType === 'agent') return agentName(source.agent?.runtime);
    const through = source.label === 'result' || source.blockType === 'search' || source.blockType === 'web' || source.blockType === 'finding' ? blockOrigin(canvas, source.id, depth + 1) : undefined;
    if (through) return through;
  }
  return undefined;
}
