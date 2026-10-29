import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

/** A dialog over the page: focus moves in and is kept inside, and goes back where it was on close.
 *  A bare dialog draws no heading; its content carries its own title and close button. */
export function Modal({ title, children, onClose, className = '', nonBlocking = false, bare = false }: { title: string; children: ReactNode; onClose: () => void; className?: string; nonBlocking?: boolean; bare?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; if (!panel.current?.contains(document.activeElement)) panel.current?.querySelector<HTMLElement>('[data-autofocus], input, select, textarea, button')?.focus(); return () => previous?.focus(); }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className={`modal ${className}`} role="dialog" aria-modal={!nonBlocking} aria-label={title} ref={panel} onKeyDown={event => { if (event.key !== 'Tab' || nonBlocking || event.defaultPrevented) return; const focusable = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') || [])]; const first = focusable[0]; const last = focusable.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }}>{!bare && <div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button></div>}{children}</div></div>;
}
