import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Hand, MousePointer2 } from 'lucide-react';
import './canvas-tool.css';

export type CanvasTool = 'move' | 'hand';

const TOOLS: { id: CanvasTool; label: string; key: string; icon: typeof Hand }[] = [
  { id: 'move', label: 'Move', key: 'V', icon: MousePointer2 },
  { id: 'hand', label: 'Hand tool', key: 'H', icon: Hand },
];
const typing = (target: EventTarget | null) => Boolean((target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], .cm-editor'));

/** The canvas tool, as in Figma: V picks Move, H picks Hand, and holding Space is Hand until it is let go. */
export function useCanvasTool() {
  const [tool, setTool] = useState<CanvasTool>('move'), [spaceHeld, setSpaceHeld] = useState(false);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      if (event.code === 'Space') {
        // A focused button or a dialog keeps Space for itself.
        if ((event.target as HTMLElement | null)?.closest?.('button, a, [role="button"], [role="dialog"], .modal')) return;
        event.preventDefault(); setSpaceHeld(true); return;
      }
      if (event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === 'v') setTool('move'); else if (key === 'h') setTool('hand');
    };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') setSpaceHeld(false); };
    const release = () => setSpaceHeld(false);
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', release);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', release); };
  }, []);
  return { tool, setTool, active: spaceHeld ? 'hand' as const : tool };
}

/** The tool button at the start of the canvas toolbar, with a small menu of tools beside it. */
export function CanvasToolSwitch({ tool, onChange }: { tool: CanvasTool; onChange: (tool: CanvasTool) => void }) {
  const [open, setOpen] = useState(false), box = useRef<HTMLDivElement>(null);
  const current = TOOLS.find(item => item.id === tool)!, Icon = current.icon;
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  return <div ref={box} className="canvas-tool-switch">
    <button className="icon-button active" aria-label={`${current.label} (${current.key})`} title={`${current.label} (${current.key})`} onClick={() => setOpen(!open)}><Icon size={16}/></button>
    <button className={`canvas-tool-more ${open ? 'open' : ''}`} aria-label="Choose canvas tool" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><ChevronDown size={13}/></button>
    {open && <div className="canvas-tool-menu" role="menu" aria-label="Canvas tools">
      {TOOLS.map(item => <button key={item.id} role="menuitemradio" aria-checked={item.id === tool} onClick={() => { onChange(item.id); setOpen(false); }}>
        <span className="canvas-tool-check">{item.id === tool && <Check size={14}/>}</span><item.icon size={16}/><span className="canvas-tool-label">{item.label}</span><kbd>{item.key}</kbd>
      </button>)}
    </div>}
  </div>;
}
