import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, LoaderCircle } from 'lucide-react';
import './chip-menu.css';

export type ChipOption<T extends string> = { id: T; label: string; detail?: string; icon?: ReactNode };

/** A setting with a few values: the chip names the current one, its menu lists the rest with a check, as in the Ros bar.
 * Replaces the native select on the Settings and Memory pages. */
export function ChipChoice<T extends string>({ label, value, options, caption, busy, disabled, onChange }: { label: string; value: T; options: ChipOption<T>[]; caption?: string; busy?: boolean; disabled?: boolean; onChange: (value: T) => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [open]);
  const current = options.find(option => option.id === value) ?? options[0]!;
  return <span className="chip-slot chip-choice">
    <button ref={trigger} type="button" className="chip-button lg" aria-label={`${label}: ${current.label}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled || busy} onClick={() => setOpen(value => !value)}>
      {current.icon}<span className="chip-menu-label">{current.label}</span>{busy ? <LoaderCircle size={12} className="spin"/> : <ChevronDown size={12}/>}
    </button>
    {open && <div ref={menuRef} className="chip-menu down right" role="menu" aria-label={label}>
      {caption && <p className="chip-menu-heading">{caption}</p>}
      {options.map(option => <button key={option.id} type="button" role="menuitemradio" aria-checked={option.id === value} onClick={() => { setOpen(false); if (option.id !== value) onChange(option.id); }}>
        {option.icon}<span className="chip-menu-text"><span className="chip-menu-label">{option.label}</span>{option.detail && <small>{option.detail}</small>}</span>{option.id === value && <span className="chip-check"><Check size={13}/></span>}
      </button>)}
    </div>}
  </span>;
}
