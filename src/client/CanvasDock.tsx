import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import './canvas-dock.css';

export type DockItem = { id: string; label: string; hint: string; icon: ReactNode; onClick: () => void; disabled?: boolean; pressed?: boolean };

const SIZE = 40, MAX_SCALE = 1.5, REACH = 100;
/** Dock-style magnification: items near the pointer grow, falling off smoothly with distance. */
const scaleFor = (distance: number) => 1 + (MAX_SCALE - 1) * Math.cos(Math.min(1, Math.abs(distance) / REACH) * Math.PI / 2);

/** Vertical canvas tools. Magnified items push their neighbours apart around the dock's centre,
 * so the dock grows evenly and nothing overlaps. Each item explains itself on hover or focus. */
export function CanvasDock({ items, label }: { items: DockItem[]; label: string }) {
  const dock = useRef<HTMLElement>(null);
  const [scales, setScales] = useState<number[] | null>(null);
  const magnify = (y: number) => {
    const element = dock.current;
    if (!element || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const top = element.getBoundingClientRect().top;
    setScales([...element.querySelectorAll<HTMLElement>('.canvas-dock-item')].map(item => scaleFor(y - (top + item.offsetTop + item.offsetHeight / 2))));
  };
  const extra = (scales ?? []).map(scale => (scale - 1) * SIZE), total = extra.reduce((sum, value) => sum + value, 0);
  let before = 0;
  return <nav ref={dock} className="canvas-dock nodrag nopan" aria-label={label} style={{ '--dock-grow': `${total / 2}px`, '--dock-widen': `${Math.max(0, ...extra)}px` } as CSSProperties}
    onPointerMove={event => { if (event.pointerType === 'mouse') magnify(event.clientY); }} onPointerLeave={() => setScales(null)}>
    {items.map((item, index) => {
      const scale = scales?.[index] ?? 1, shift = before + (extra[index] ?? 0) / 2 - total / 2;
      before += extra[index] ?? 0;
      return <button key={item.id} className={`canvas-dock-item ${item.pressed ? 'active' : ''}`} style={{ translate: `0 ${shift}px`, scale: `${scale}` }} aria-label={item.label} aria-describedby={`dock-hint-${item.id}`} aria-pressed={item.pressed} disabled={item.disabled} onClick={item.onClick}>
        {item.icon}
        <span className="canvas-dock-tip" role="tooltip" id={`dock-hint-${item.id}`} style={{ scale: `${1 / scale}` }}><strong>{item.label}</strong>{item.hint}</span>
      </button>;
    })}
  </nav>;
}
