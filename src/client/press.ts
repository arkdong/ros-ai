import type { MouseEvent } from 'react';

/**
 * Props for a menu trigger that opens as the mouse button goes down, not when it comes up, so a menu
 * appears the moment it is pressed. Enter and Space still work: they arrive as a click with no mouse press.
 */
export function openOnPress(toggle: () => void) {
  return {
    onMouseDown: (event: MouseEvent<HTMLElement>) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); toggle(); },
    onClick: (event: MouseEvent<HTMLElement>) => { if (event.detail === 0) toggle(); },
  };
}
