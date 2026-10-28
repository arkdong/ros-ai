import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, LayoutGrid, Search } from 'lucide-react';
import { BLOCK_KINDS, mostUsedKinds, searchKinds, type BlockKind, type KindId } from './block-kinds';
import { KindPreview } from './KindPreview';
import './chip-menu.css';
import './add-block-menu.css';

const REST = 300;
type Row = { id: string; kind?: BlockKind; label: string; caption: string };

/** Add block: the six kinds this person adds most, typing to find any kind, and All blocks for the rest.
 *  Resting on a row shows the block as it looks on the map, one line on what it does, and what it needs. */
export function AddBlockMenu({ left, top, local, onPick, onBrowse, onClose }: { left: number; top: number; local: boolean; onPick: (kind: BlockKind) => void; onBrowse: (kind?: BlockKind) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null), rest = useRef<number | null>(null);
  const [query, setQuery] = useState(''), [active, setActive] = useState(0), [preview, setPreview] = useState<KindId | null>(null), [lift, setLift] = useState(0);
  const searching = Boolean(query.trim());
  const kinds = searching ? searchKinds(query, local) : mostUsedKinds(local);
  const rows: Row[] = [...kinds.map(kind => ({ id: kind.id, kind, label: kind.name, caption: kind.caption })), ...(searching ? [] : [{ id: 'all', label: 'All blocks', caption: String(BLOCK_KINDS.filter(kind => local || !kind.localOnly).length) }])];
  const current = rows[Math.min(active, rows.length - 1)];
  // The menu stays above the Ros bar and inside the map: when it would run under either, it moves up by the overlap.
  useLayoutEffect(() => {
    const menu = box.current;
    if (!menu) return;
    const bar = (menu.closest('.canvas-stage') ?? document).querySelector('.ros-dock'), area = menu.parentElement?.getBoundingClientRect();
    const floor = Math.min(bar?.getBoundingClientRect().top ?? Infinity, area?.bottom ?? Infinity) - 12;
    setLift(Math.max(0, menu.getBoundingClientRect().bottom + lift - floor));
  }, [rows.length]);
  useEffect(() => {
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener('pointerdown', away);
    return () => { document.removeEventListener('pointerdown', away); if (rest.current) clearTimeout(rest.current); };
  }, [onClose]);
  const choose = (row: Row | undefined) => { if (!row) return; if (row.kind) onPick(row.kind); else onBrowse(); };
  const restOn = (row: Row, index: number) => { setActive(index); if (rest.current) clearTimeout(rest.current); if (!row.kind) { setPreview(null); return; } rest.current = window.setTimeout(() => setPreview(row.kind!.id), REST); };
  const leaveRows = () => { if (rest.current) clearTimeout(rest.current); setPreview(null); };
  const shown = preview && rows.find(row => row.id === preview)?.kind;
  return <div ref={box} className="add-block-menu nodrag nopan nowheel" role="dialog" aria-label="Add block" style={{ left, top: Math.max(8, top - lift) }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(index + 1, rows.length - 1)); setPreview(null); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); setPreview(null); }
      else if (event.key === 'Enter') { event.preventDefault(); choose(current); }
    }}>
    <label className="add-block-search"><Search size={13}/><input value={query} placeholder="Type to find a block" aria-label="Find a block" autoFocus onChange={event => { setQuery(event.target.value); setActive(0); setPreview(null); }}/></label>
    {!searching && <p>Most used</p>}
    {searching && !rows.length && <p className="add-block-none">No block matches. Ros adds blocks too: ask in the bar.</p>}
    <div className="add-block-rows" onPointerLeave={leaveRows}>
      {rows.map((row, index) => <span key={row.id} className="add-block-slot">
        {row.id === 'all' && <hr/>}
        <button type="button" className={`add-block-row ${index === active ? 'active' : ''}`} role="menuitem" onPointerEnter={() => restOn(row, index)} onFocus={() => setActive(index)} onClick={() => choose(row)}>
          {row.kind ? row.kind.icon(14) : <LayoutGrid size={14}/>}<span>{row.label}</span><span className="add-block-cap">{row.caption}{row.id === 'all' && <ChevronRight size={11}/>}</span>
        </button>
        {shown && row.id === shown.id && <div className="add-block-pop">
          <KindPreview kind={shown.id}/>
          <div className="add-block-line">{shown.line}</div>
          <div className="add-block-foot"><span className="ros-chip">{shown.needs === 'Nothing' && <span className="chip-dot"/>}{shown.needs}</span><span className="sp"/><span>{shown.asks ? 'Enter opens it' : 'Enter to add'}</span></div>
        </div>}
      </span>)}
    </div>
  </div>;
}
