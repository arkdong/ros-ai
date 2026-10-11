import { ArrowRight, BookOpen, CircleAlert, FlaskConical, FolderTree, GitBranch } from 'lucide-react';
import type { AssistantStructurePreview as StructurePreview } from '../shared/assistant-presentation';
import { layoutOnly } from '../shared/canvas-position';
import type { CanvasNode, Proposal } from '../shared/types';
import { RichText } from './Content';
import './assistant-structure-preview.css';

type Props = {
  structure: StructurePreview;
  existingNodes: readonly CanvasNode[];
  validation?: 'draft' | 'proposal';
};
type PreviewNote = StructurePreview['notes'][number];
const kindLabel = (kind: PreviewNote['kind']) => kind === 'group' ? 'Group' : kind === 'activity' ? 'Action' : 'Knowledge';

/** Read-only projection. A saved proposal supplies authority separately from
 * this presentation; recovering model JSON never creates an actionable draft. */
export function proposalStructurePreview(proposal: Proposal, existingNodes: readonly CanvasNode[]): StructurePreview | null {
  const nodes = new Map(existingNodes.map(node => [node.id, node]));
  const changedIds = new Set<string>();
  const updates = new Map<string, string>();
  const relationships: StructurePreview['relationships'] = [];
  for (const operation of proposal.operations) {
    if (operation.type === 'addNode') { nodes.set(operation.node.id, operation.node); changedIds.add(operation.node.id); }
    else if (operation.type === 'updateNode') {
      const node = nodes.get(operation.id);
      if (!node) continue;
      nodes.set(operation.id, { ...node, ...operation.patch });
      // A block that only moves is not listed; one that only changes group says where it goes.
      if (layoutOnly(operation.patch)) continue;
      changedIds.add(operation.id);
      const moves = layoutOnly(Object.fromEntries(Object.entries(operation.patch).filter(([key]) => key !== 'parentId'))) && updates.get(operation.id) !== 'Updates an existing card.';
      updates.set(operation.id, !moves ? 'Updates an existing card.' : operation.patch.parentId ? 'Moves into this group.' : 'Moves out of its group.');
    } else if (operation.type === 'removeNode') { nodes.delete(operation.id); changedIds.delete(operation.id); }
    else if (operation.type === 'addConnection') relationships.push({ source: operation.connection.source, target: operation.connection.target, label: operation.connection.label });
  }
  const notes: StructurePreview['notes'] = [];
  for (const id of changedIds) {
    const node = nodes.get(id);
    if (!node) continue;
    notes.push({ id, title: node.title, description: node.description, kind: node.kind === 'group' ? 'group' : node.kind === 'activity' ? 'activity' : 'topic', parentId: node.parentId ?? null, ...(updates.has(id) ? { rationale: updates.get(id) } : {}) });
  }
  return notes.length || relationships.length ? { summary: proposal.summary, validated: false, notes, relationships } : null;
}

export function AssistantStructurePreview({ structure, existingNodes, validation = 'draft' }: Props) {
  const notes = [...new Map(structure.notes.map(note => [note.id, note])).values()];
  const byId = new Map(notes.map(note => [note.id, note]));
  const existingById = new Map(existingNodes.map(node => [node.id, node]));
  const children = new Map<string, PreviewNote[]>();
  for (const note of notes) {
    if (note.parentId && byId.has(note.parentId)) children.set(note.parentId, [...(children.get(note.parentId) ?? []), note]);
  }
  const warnings: string[] = [];
  if (notes.length !== structure.notes.length) warnings.push('Repeated card identifiers need review; each identifier is shown once.');
  const parentWarning = new Map<string, string>();
  const invalidParents = new Map<string, string>();
  for (const note of notes) {
    if (!note.parentId) continue;
    const parent = byId.get(note.parentId) ?? existingById.get(note.parentId);
    if (!parent) parentWarning.set(note.id, 'The proposed parent is unavailable. Placement needs review.');
    else if (parent.kind !== 'group') invalidParents.set(note.parentId, `${parent.title || 'This parent'} is ${parent.kind === 'activity' ? 'an Action' : 'a Knowledge card'}. Only a Group can contain other cards.`);
  }
  warnings.push(...invalidParents.values());
  const rows: { note: PreviewNote; depth: number; cycle: boolean }[] = [];
  const visited = new Set<string>();
  const circularIds = new Set<string>();
  for (const note of notes) {
    const path: string[] = [];
    let current: { id: string; parentId?: string | null } | undefined = note;
    while (current) {
      const earlier = path.indexOf(current.id);
      if (earlier >= 0) { for (const id of path.slice(earlier)) circularIds.add(id); break; }
      path.push(current.id);
      current = current.parentId ? byId.get(current.parentId) ?? existingById.get(current.parentId) : undefined;
    }
  }
  const visit = (note: PreviewNote, depth: number) => {
    if (visited.has(note.id)) return;
    visited.add(note.id);
    rows.push({ note, depth, cycle: circularIds.has(note.id) });
    for (const child of children.get(note.id) ?? []) visit(child, depth + 1);
  };
  for (const note of notes.filter(note => !note.parentId || !byId.has(note.parentId))) visit(note, 0);
  for (const note of notes) if (!visited.has(note.id)) {
    warnings.push('A circular parent relationship needs review. These cards are shown without implying valid containment.');
    visit(note, 0);
  }
  const titleFor = (id: string) => byId.get(id)?.title ?? existingById.get(id)?.title ?? 'Unresolved card';
  return <section className={`assistant-structure-preview ${validation}`} aria-label={validation === 'draft' ? 'Draft card structure, not applied' : 'Pending canvas proposal outline'}>
    <header><GitBranch size={14} aria-hidden="true"/><strong>{validation === 'draft' ? 'Proposed card outline' : 'Canvas changes'}</strong><span>{validation === 'draft' ? 'Draft · not applied' : 'Pending review'}</span></header>
    {structure.summary && <div className="structure-summary"><RichText text={structure.summary}/></div>}
    {warnings.length > 0 && <div className="structure-warning" role="note"><CircleAlert size={13} aria-hidden="true"/><p>{[...new Set(warnings)].join(' ')}</p></div>}
    {rows.length > 0 && <ol className="structure-card-outline" aria-label="Proposed cards in parent order">{rows.map(({ note, depth, cycle }) => {
      const Icon = note.kind === 'group' ? FolderTree : note.kind === 'activity' ? FlaskConical : BookOpen;
      const externalParent = note.parentId && !byId.has(note.parentId) ? existingById.get(note.parentId) : undefined;
      return <li key={note.id} className={`structure-card ${note.kind}${depth ? ' nested' : ''}`} data-depth={depth} style={{ marginInlineStart: Math.min(depth, 4) * 26 }}>
        {depth > 0 && <span className="structure-branch" aria-hidden="true"/>}
        <div className="structure-card-heading"><span className={`structure-kind-mark ${note.kind}`}><Icon size={15} aria-hidden="true"/></span><div><strong>{note.title || 'Untitled card'}</strong><span>{kindLabel(note.kind)}{externalParent && <> · {cycle ? 'parent needs review: ' : 'inside '}{externalParent.title}</>}{depth > 4 && <> · nesting level {depth + 1}</>}</span></div></div>
        {(parentWarning.has(note.id) || cycle) && <p className="structure-parent-warning"><CircleAlert size={12} aria-hidden="true"/>{cycle ? 'This parent relationship is circular and needs review.' : parentWarning.get(note.id)}</p>}
        {(note.description || note.rationale) && <details className="structure-card-details"><summary>Details{note.rationale ? ' & rationale' : ''}</summary>{note.description && <RichText text={note.description}/>} {note.rationale && <div className="structure-rationale"><span>Why this card</span><RichText text={note.rationale}/></div>}</details>}
      </li>;
    })}</ol>}
    {structure.relationships.length > 0 && <details className="structure-relationships"><summary>{structure.relationships.length} relationship{structure.relationships.length === 1 ? '' : 's'}</summary><p>Relationships do not schedule work or import inputs.</p><ul>{structure.relationships.map((relationship, index) => <li key={index}><div><strong>{titleFor(relationship.source)}</strong><ArrowRight size={12} aria-label="relates to"/><strong>{titleFor(relationship.target)}</strong></div><span>{relationship.label || 'Related'}</span>{(!byId.has(relationship.source) && !existingById.has(relationship.source) || !byId.has(relationship.target) && !existingById.has(relationship.target)) && <small>Endpoint needs review.</small>}</li>)}</ul></details>}
    <details className="structure-identifiers"><summary>Exact card identifiers</summary><ul>{notes.map(note => <li key={note.id}><span>{note.title || 'Untitled card'}</span><code>{note.id}</code>{note.parentId && <small>Parent: <code>{note.parentId}</code></small>}</li>)}{structure.relationships.map((relationship, index) => <li key={`relationship-${index}`}><span>{relationship.label || 'Related'}</span><code>{relationship.source} → {relationship.target}</code></li>)}</ul></details>
    {validation === 'draft' && <p className="structure-draft-caption">This preview has not been validated or applied.</p>}
  </section>;
}
