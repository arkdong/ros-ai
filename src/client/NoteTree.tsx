import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react';
import type { CanvasNode, Run } from '../shared/types';
import { KindIcon } from './Canvas';
import { readSaved, saveLocal } from './persistence';
import { textPreview } from '../shared/presentation';

export function NoteTree({ projectId, nodes, runs, selectedId, onSelect }: {
  projectId: string; nodes: CanvasNode[]; runs: Run[]; selectedId: string | null; onSelect: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<string[]>(() => readSaved(`notes-collapsed:${projectId}`, []));
  const tree = useRef<HTMLDivElement>(null);
  useEffect(() => { saveLocal(`notes-collapsed:${projectId}`, collapsed); }, [projectId, collapsed]);
  const ids = new Set(nodes.map(node => node.id));
  // Leave room for expand arrows only when some block sits inside a Group.
  const branches = nodes.some(node => node.parentId && ids.has(node.parentId));
  const children = (parentId: string | null) => nodes.filter(node => parentId ? node.parentId === parentId : !node.parentId || !ids.has(node.parentId)).sort((a, b) => a.y - b.y || a.x - b.x || a.title.localeCompare(b.title));
  const toggle = (id: string) => setCollapsed(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>, node: CanvasNode, hasChildren: boolean, expanded: boolean) => {
    const rows = [...(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') || [])];
    const index = rows.indexOf(event.currentTarget);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus(); }
    if (event.key === 'ArrowRight' && hasChildren) { event.preventDefault(); if (!expanded) toggle(node.id); else rows[index + 1]?.focus(); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); if (hasChildren && expanded) toggle(node.id); else rows.find(row => row.dataset.nodeId === node.parentId)?.focus(); }
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); (event.key === 'Home' ? rows[0] : rows.at(-1))?.focus(); }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node.id); }
  };
  const render = (node: CanvasNode, depth: number, ancestors: Set<string>) => {
    if (ancestors.has(node.id)) return null;
    const nested = children(node.id); const expanded = !collapsed.includes(node.id);
    const busy = runs.some(run => run.nodeId === node.id && ['queued', 'running'].includes(run.status));
    const next = new Set([...ancestors, node.id]);
    return <div className="note-tree-branch" key={node.id}>
      <div className={`note-tree-row ${selectedId === node.id ? 'selected' : ''}`} role="treeitem" aria-selected={selectedId === node.id} aria-expanded={nested.length ? expanded : undefined} aria-level={depth + 1} aria-label={node.title} tabIndex={0} data-node-id={node.id} style={{ paddingLeft: 8 + depth * 16 }} onClick={() => onSelect(node.id)} onKeyDown={event => keyDown(event, node, nested.length > 0, expanded)}>
        {nested.length ? <button className="note-tree-toggle" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.title} in Notes`} tabIndex={-1} onClick={event => { event.stopPropagation(); toggle(node.id); }}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : branches && <span className="note-tree-spacer" />}
        <KindIcon kind={node.kind} blockType={node.blockType} size={14} /><span className="note-tree-title" title={node.title}>{textPreview(node.title,64).text}</span>{busy && <LoaderCircle size={12} className="spin" />}
      </div>
      {nested.length > 0 && expanded && <div role="group">{nested.map(child => render(child, depth + 1, next))}</div>}
    </div>;
  };
  return <div className="note-tree" role="tree" aria-label="Project blocks and groups" ref={tree}>{nodes.length ? children(null).map(node => render(node, 0, new Set())) : <p className="sidebar-empty">Blocks and Groups you add to the canvas will appear here.</p>}</div>;
}
