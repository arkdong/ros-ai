import type { MouseEvent, ReactNode } from 'react';
import './canvas-dock.css';

export type DockItem =
  | { id: string; label: string; hint?: string; icon: ReactNode; onClick: (event: MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; pressed?: boolean; expanded?: boolean; controls?: string; testId?: string; primary?: boolean }
  | { id: string; divider: true };

/** The map's tools in one card at the top left: a column of tiles, with a hairline between the groups.
 *  Each tile names itself in one line on hover or focus. The one primary tile, Add block, is the card's black action. */
export function CanvasDock({ items, label }: { items: DockItem[]; label: string }) {
  return <div className="canvas-dock nodrag nopan" role="toolbar" aria-orientation="vertical" aria-label={label}>
    {items.map(item => 'divider' in item
      ? <span key={item.id} className="canvas-dock-divider" role="separator"/>
      : <button key={item.id} type="button" className={`canvas-dock-item ${item.pressed ? 'active' : ''}${item.primary ? ' primary' : ''}`} data-testid={item.testId} aria-label={item.label} aria-describedby={`dock-hint-${item.id}`} aria-pressed={item.pressed} aria-expanded={item.expanded} aria-controls={item.controls} disabled={item.disabled} onClick={item.onClick}>
        {item.icon}
        <span className="canvas-dock-tip" role="tooltip" id={`dock-hint-${item.id}`}><strong>{item.label}</strong>{item.hint && <span>{item.hint}</span>}</span>
      </button>)}
  </div>;
}
