import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react';
import type { CanvasNode, Run } from '../shared/types';
import { KindIcon } from './Canvas';
import { readSaved, saveLocal } from './persistence';
import { textPreview } from '../shared/presentation';

/** The open project's blocks as a tree. Groups start closed and fold from a chevron at the end of their row, as the project
 * row does; the groups above the selected block open on their own. Which groups are open is remembered per project. */
export function NoteTree({ projectId, nodes, runs, selectedId, limit, onSelect }: {
  projectId: string; nodes: CanvasNode[]; runs: Run[]; selectedId: string | null; limit?: number; onSelect: (id: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<string[]>(() => readSaved(`notes-expanded:${projectId}`, []));
  const tree = useRef<HTMLDivElement>(null);
  useEffect(() => { saveLocal(`notes-expanded:${projectId}`, expanded); }, [projectId, expanded]);
  const ids = new Set(nodes.map(node => node.id));
  const byId = new Map(nodes.map(node => [node.id, node]));
  useEffect(() => {
    const above: string[] = [];
    for (let parent = selectedId ? byId.get(selectedId)?.parentId : undefined; parent && byId.has(parent) && !above.includes(parent); parent = byId.get(parent)?.parentId) above.push(parent);
    if (above.some(id => !expanded.includes(id))) setExpanded(current => [...new Set([...current, ...above])]);
  }, [selectedId, nodes, expanded]); // eslint-disable-line react-hooks/exhaustive-deps -- byId follows nodes
  const children = (parentId: string | null) => nodes.filter(node => parentId ? node.parentId === parentId : !node.parentId || !ids.has(node.parentId)).sort((a, b) => a.y - b.y || a.x - b.x || a.title.localeCompare(b.title));
  const toggle = (id: string) => setExpanded(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>, node: CanvasNode, hasChildren: boolean, open: boolean) => {
    const rows = [...(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') || [])];
    const index = rows.indexOf(event.currentTarget);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus(); }
    if (event.key === 'ArrowRight' && hasChildren) { event.preventDefault(); if (!open) toggle(node.id); else rows[index + 1]?.focus(); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); if (hasChildren && open) toggle(node.id); else rows.find(row => row.dataset.nodeId === node.parentId)?.focus(); }
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); (event.key === 'Home' ? rows[0] : rows.at(-1))?.focus(); }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node.id); }
  };
  const render = (node: CanvasNode, depth: number, ancestors: Set<string>) => {
    if (ancestors.has(node.id)) return null;
    const nested = children(node.id); const open = expanded.includes(node.id);
    const busy = runs.some(run => run.nodeId === node.id && ['queued', 'running'].includes(run.status));
    const next = new Set([...ancestors, node.id]);
    return <div className="note-tree-branch" key={node.id}>
      <div className={`note-tree-row ${selectedId === node.id ? 'selected' : ''}`} role="treeitem" aria-selected={selectedId === node.id} aria-expanded={nested.length ? open : undefined} aria-level={depth + 1} aria-label={node.title} tabIndex={0} data-node-id={node.id} style={{ paddingLeft: 8 + depth * 16 }} onClick={() => onSelect(node.id)} onKeyDown={event => keyDown(event, node, nested.length > 0, open)}>
        <KindIcon kind={node.kind} blockType={node.blockType} google={node.google?.kind} map={node.map?.provider} size={14} /><span className="note-tree-title" title={node.title}>{textPreview(node.title,64).text}</span>{busy && <LoaderCircle size={12} className="spin" />}
        {nested.length > 0 && <button className="note-tree-toggle" aria-label={`${open ? 'Collapse' : 'Expand'} ${node.title}`} tabIndex={-1} onClick={event => { event.stopPropagation(); toggle(node.id); }}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>}
      </div>
      {nested.length > 0 && open && <div role="group">{nested.map(child => render(child, depth + 1, next))}</div>}
    </div>;
  };
  const roots = children(null);
  // Like a chat list: the first few blocks, then "Show more" for the rest.
  const hidden = limit && !showAll && roots.length > limit ? roots.length - limit : 0;
  const shown = hidden ? roots.slice(0, limit) : roots;
  return <div className="note-tree" role="tree" aria-label="Project blocks and groups" ref={tree}>
    {nodes.length ? shown.map(node => render(node, 0, new Set())) : <p className="sidebar-empty">No blocks yet</p>}
    {hidden > 0 && <button type="button" className="note-tree-more" onClick={() => setShowAll(true)}>Show more</button>}
    {limit && showAll && roots.length > limit && <button type="button" className="note-tree-more" onClick={() => setShowAll(false)}>Show less</button>}
  </div>;
}
