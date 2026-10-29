import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, PanelRight, RectangleHorizontal, X } from 'lucide-react';
import type { CanvasNode } from '../shared/types';
import { TEXT_LABELS, kindName, sentence, textLabel } from '../shared/vocabulary';
import { readSaved, saveLocal } from './persistence';
import { KindIcon } from './Canvas';
import './chip-menu.css';
import './block-sheet.css';

/** How an open block shows: a sheet over the map, or a panel beside it. The choice sticks per project. */
export type BlockViewMode = 'sheet' | 'panel';
export const readBlockViewMode = (projectId: string): BlockViewMode => readSaved<string>(`block-view:${projectId}`, 'sheet') === 'panel' ? 'panel' : 'sheet';
export const saveBlockViewMode = (projectId: string, mode: BlockViewMode) => saveLocal(`block-view:${projectId}`, mode);

type Props = {
  node: CanvasNode; mode: BlockViewMode; onMode: (mode: BlockViewMode) => void; onClose: () => void;
  /** Saves a new title typed in the header; absent when the title cannot change here. */
  onRename?: (title: string) => void;
  /** What sits before the view switch in the header, such as Code's Run button. */
  head?: ReactNode;
  /** The footer's chips, and the word at its right end. */
  foot?: ReactNode; status?: ReactNode;
  children: ReactNode;
};

/** An open block: a kind chip, its title and the view switch on top, the block itself, and one footer line.
 *  As a sheet it floats over the map with the ROS bar still below it; as a panel it stands beside the map. */
export function BlockSheet({ node, mode, onMode, onClose, onRename, head, foot, status, children }: Props) {
  const box = useRef<HTMLDivElement>(null);
  // Focus moves into the block when it opens, and back where it was when it closes, as the dialog did.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (!box.current?.contains(document.activeElement)) box.current?.querySelector<HTMLElement>('[data-autofocus], .cm-content, textarea, input:not([type="file"]):not(.bv-title), button')?.focus();
    return () => previous?.focus();
  }, [node.id, mode]);
  const view = <div ref={box} className={`block-view ${mode === 'sheet' ? 'block-sheet' : 'block-panel'}`} role={mode === 'sheet' ? 'dialog' : 'complementary'} aria-label={`${kindName(node)} · ${node.title}`} data-testid="block-view">
    <header className="bv-head">
      <span className="bv-kind"><KindIcon kind={node.kind} blockType={node.blockType} google={node.google?.kind} size={13}/>{kindName(node)}</span>
      {onRename ? <TitleField key={node.id} title={node.title} onRename={onRename}/> : <h2 className="bv-title" title={node.title}>{node.title}</h2>}
      {head}
      <span className="bv-views" role="group" aria-label="Show the block as">
        <button type="button" className={`icon-button${mode === 'sheet' ? ' active' : ''}`} aria-pressed={mode === 'sheet'} aria-label="Sheet over the map" title="Sheet over the map" onClick={() => onMode('sheet')}><RectangleHorizontal size={15}/></button>
        <button type="button" className={`icon-button${mode === 'panel' ? ' active' : ''}`} aria-pressed={mode === 'panel'} aria-label="Panel beside the map" title="Panel beside the map" onClick={() => onMode('panel')}><PanelRight size={15}/></button>
      </span>
      <button type="button" className="icon-button" aria-label="Close" title="Close (Esc)" onClick={onClose}><X size={16}/></button>
    </header>
    <div className="bv-body">{children}</div>
    <footer className="bv-foot">{foot}<span className="bv-sp"/>{status && <span className="bv-status">{status}</span>}</footer>
  </div>;
  return mode === 'sheet' ? <div className="block-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>{view}</div> : view;
}

/** The title in the header, edited in place and saved when you leave it or press Enter. */
function TitleField({ title, onRename }: { title: string; onRename: (title: string) => void }) {
  const [value, setValue] = useState(title);
  useEffect(() => setValue(title), [title]);
  const commit = () => { const next = value.trim().slice(0, 200); if (next && next !== title) onRename(next); else setValue(title); };
  return <input className="bv-title" aria-label="Block title" value={value} maxLength={200} onChange={event => setValue(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}/>;
}

/** The label of a Text block as a footer chip with its menu, as the ROS bar does for its choices. */
export function LabelChip({ node, onPick }: { node: CanvasNode; onPick: (value: string) => void }) {
  const [open, setOpen] = useState(false), box = useRef<HTMLSpanElement>(null);
  const current = textLabel(node) ?? '';
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  return <span ref={box} className="chip-slot" onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
    <button type="button" className={`chip-button${current ? ' set' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{current ? sentence(current) : '+ label'}<ChevronDown size={12}/></button>
    {open && <div className="chip-menu" role="menu" aria-label="Label">{['', ...TEXT_LABELS].map(word => <button key={word || 'none'} type="button" role="menuitemradio" aria-checked={current === word} onClick={() => { setOpen(false); if (word !== current) onPick(word); }}><span className="chip-check">{current === word && <Check size={13}/>}</span>{word ? sentence(word) : 'No label'}</button>)}</div>}
  </span>;
}
