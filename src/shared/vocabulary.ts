import type { CanvasNode } from './types.js';

/** The words a Text block can carry as its label; the researcher's own word (at most 40 characters) is allowed too. */
export const TEXT_LABELS = ['question', 'plan', 'task', 'result', 'finding', 'decision', 'draft', 'report'] as const;

/** What a block is on screen: seven kinds plus Group. Storage keeps the older blockType and kind words as aliases
 * (note, action, report and finding are all Text; dataset is Data; figure is File; notion is External). */
export type KindName = 'Text' | 'Code' | 'Notebook' | 'Data' | 'File' | 'External' | 'Agent' | 'Group' | 'Search';
export function kindName(node: Pick<CanvasNode, 'kind' | 'blockType'>): KindName {
  if (node.kind === 'group') return 'Group';
  switch (node.blockType) {
    case 'code': return 'Code';
    case 'notebook': return 'Notebook';
    case 'dataset': return 'Data';
    case 'figure': return 'File';
    case 'notion': return 'External';
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
  return runtime === 'claude' ? 'Claude Code' : runtime === 'codex' ? 'Codex' : runtime === 'model' ? 'Ros' : 'Agent';
}
