import { useEffect, useRef, type RefObject } from 'react';
import { readSaved, saveLocal } from './persistence';

/** How far a floating window has been moved from where it opens, in pixels. */
export type Offset = { x: number; y: number };
type Box = { left: number; top: number; right: number; bottom: number };

/** How much of a moved window's width must stay inside the area it floats over: half of it, so part of the header is
 *  always there to drag it back by, and never less than this many pixels. */
const KEEP = 160;

/** The offset nearest to `offset` that keeps the window's header inside `area`. `home` is where the window sits
 *  with no offset; `header` is its header's height. A window larger than the area keeps its top left corner in. */
export function clampOffset(offset: Offset, home: Box, area: Box, header: number): Offset {
  const width = home.right - home.left;
  const keepX = Math.min(width, Math.max(KEEP, width / 2));
  const minX = area.left - home.left - (width - keepX), maxX = area.right - home.left - keepX;
  const minY = area.top - home.top, maxY = area.bottom - home.top - Math.max(24, header);
  const x = Math.round(Math.min(Math.max(offset.x, minX), Math.max(minX, maxX)));
  const y = Math.round(Math.min(Math.max(offset.y, minY), Math.max(minY, maxY)));
  return { x: Object.is(x, -0) ? 0 : x, y: Object.is(y, -0) ? 0 : y };
}

/** Controls where a press in the header does its own thing instead of moving the window. A title field moves the
 *  window too while it is not being edited: a click puts the caret in it, a drag moves the window. */
const OWN_POINTER = 'button, a, select, textarea, [role="menu"], [role="menuitem"], [contenteditable="true"], input:not(.drag-title)';

/** Lets a floating window be moved by dragging its header (the first `header` element inside it), anywhere over the
 *  area it floats on. The place is kept under `key`, so it opens there next time; a double click on the header puts it
 *  back where it opens. The move uses the CSS `translate` property, so the window's own `transform` and its opening
 *  animation are untouched. */
export function useDragMove(box: RefObject<HTMLElement | null>, key: string, enabled = true) {
  const offset = useRef<Offset>({ x: 0, y: 0 });
  useEffect(() => {
    const element = box.current;
    if (!element || !enabled) return;
    const header = element.querySelector<HTMLElement>(':scope > header');
    if (!header) return;
    const area = () => (element.offsetParent ?? element.parentElement ?? document.body).getBoundingClientRect();
    const home = (): Box => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left - offset.current.x, top: rect.top - offset.current.y, right: rect.right - offset.current.x, bottom: rect.bottom - offset.current.y };
    };
    const place = (next: Offset, save = false) => {
      offset.current = clampOffset(next, home(), area(), header.offsetHeight);
      element.style.translate = offset.current.x || offset.current.y ? `${offset.current.x}px ${offset.current.y}px` : '';
      element.classList.toggle('moved', Boolean(offset.current.x || offset.current.y));
      if (save) saveLocal(key, offset.current);
    };
    // Back where it was left, kept inside the window as it is now.
    const saved = readSaved<Partial<Offset> | null>(key, null);
    offset.current = { x: 0, y: 0 };
    place({ x: Number(saved?.x) || 0, y: Number(saved?.y) || 0 });
    header.classList.add('drag-handle');

    let drag: { id: number; startX: number; startY: number; from: Offset; moving: boolean; title: HTMLInputElement | null } | null = null;
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      if (event.target.closest(OWN_POINTER)) return;
      const title = event.target.closest<HTMLInputElement>('input.drag-title');
      if (title && document.activeElement === title) return; // Editing the title: the press selects text.
      event.preventDefault(); // No text selection, and an unfocused title waits to see whether this is a click or a drag.
      drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, from: offset.current, moving: false, title };
      header.setPointerCapture?.(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
      if (!drag.moving && Math.hypot(dx, dy) < 4) return;
      if (!drag.moving) { drag.moving = true; element.classList.add('dragging'); }
      place({ x: drag.from.x + dx, y: drag.from.y + dy });
    };
    const up = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const { moving, title } = drag;
      drag = null;
      element.classList.remove('dragging');
      if (header.hasPointerCapture?.(event.pointerId)) header.releasePointerCapture(event.pointerId);
      if (moving) place(offset.current, true);
      else if (title) { title.focus(); const end = title.value.length; title.setSelectionRange(end, end); }
    };
    const reset = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(`${OWN_POINTER}, input`)) return;
      place({ x: 0, y: 0 }, true);
    };
    const resize = () => place(offset.current);
    header.addEventListener('pointerdown', down);
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', up);
    header.addEventListener('pointercancel', up);
    header.addEventListener('dblclick', reset);
    window.addEventListener('resize', resize);
    return () => {
      header.removeEventListener('pointerdown', down);
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', up);
      header.removeEventListener('pointercancel', up);
      header.removeEventListener('dblclick', reset);
      window.removeEventListener('resize', resize);
      header.classList.remove('drag-handle');
      element.classList.remove('moved', 'dragging');
      element.style.translate = '';
    };
  }, [box, key, enabled]);
}
