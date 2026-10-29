import { useEffect, useState } from 'react';
import './canvas-tool.css';

export type CanvasTool = 'move' | 'hand';

const typing = (target: EventTarget | null) => Boolean((target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], .cm-editor'));

/** The canvas tool, as in Figma: V picks Move, H picks Hand, and holding Space is Hand until it is let go.
 *  Blocks drag the same way with either tool; a drag on empty canvas draws a selection box with Move and moves the
 *  canvas with Hand. While Space is held, a drag moves the canvas even when it starts on a block. */
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
  return { tool, setTool, active: spaceHeld ? 'hand' as const : tool, spaceHeld };
}
