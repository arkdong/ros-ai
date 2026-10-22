import type { Canvas, CanvasNode, Decision } from './types.js';
import { CARD_SIZE, LAYOUT_GAP } from './layout.js';
import { DECISION_LINK } from './vocabulary.js';
export { DECISION_LINK };

/** Older projects kept a researcher's decisions as a log inside the block they were recorded in, where
 * only the report export could read them. On the canvas a decision is a Text block labelled decision,
 * linked to the block it rests on, so every agent reads it through the canvas listing. The conversion
 * runs once when a project is read and is deterministic: a decision keeps its id as the id of its block. */
export function convertDecisionLogs(canvas: Canvas, artifactTitle: (id: string) => string | undefined = () => undefined): Canvas {
  if (!canvas.nodes.some(node => node.decisions?.length)) return canvas;
  const ids = new Set(canvas.nodes.map(node => node.id));
  const nodes: CanvasNode[] = [], connections = [...canvas.connections];
  for (const node of canvas.nodes) {
    const { decisions, ...rest } = node;
    nodes.push(decisions ? rest : node);
    (decisions ?? []).forEach((decision, index) => {
      if (ids.has(decision.id)) return;
      ids.add(decision.id);
      nodes.push(decisionBlock(node, decision, index, artifactTitle));
      connections.push({ id: `decision-link-${decision.id}`, source: decision.id, target: node.id, label: DECISION_LINK });
    });
  }
  return { ...canvas, nodes, connections };
}

function decisionBlock(node: CanvasNode, decision: Decision, index: number, artifactTitle: (id: string) => string | undefined): CanvasNode {
  const text = decision.text.trim() || 'Decision';
  const title = `${decision.withdrawnAt ? 'Withdrawn: ' : ''}${text}`;
  const basis = decision.basedOn.map(item => `${artifactTitle(item.artifactId) ?? 'a saved version'} · version ${item.hash.slice(0, 12)}`);
  const description = [
    decision.reason.trim() ? `Reason: ${decision.reason.trim()}` : '',
    basis.length ? `Based on: ${basis.join('; ')}` : '',
    `Recorded ${when(decision.at)} in “${node.title}”.${decision.withdrawnAt ? ` Withdrawn ${when(decision.withdrawnAt)}.` : ''}`,
  ].filter(Boolean).join('\n\n');
  return {
    id: decision.id, title: title.length > 200 ? `${title.slice(0, 199)}…` : title, description,
    kind: 'topic', blockType: 'note', label: 'decision', parentId: node.parentId ?? null,
    x: node.x + CARD_SIZE.width + LAYOUT_GAP, y: node.y + index * (CARD_SIZE.height + LAYOUT_GAP / 2),
  };
}

const when = (iso: string) => iso.replace('T', ' ').slice(0, 16);
