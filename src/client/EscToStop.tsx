import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Square } from 'lucide-react';

/** How long the first Esc keeps Stop armed. A second Esc inside it stops ROS. */
export const ESC_STOP_WINDOW_MS = 3000;

// One arm shared by the bar and the panel, so the first Esc can close the panel and the second still stops from the bar.
let armedUntil = 0, timer: number | undefined;
const listeners = new Set<() => void>();
const setArmed = (until: number) => {
  if (until === armedUntil) return;
  armedUntil = until; window.clearTimeout(timer);
  if (until) timer = window.setTimeout(() => setArmed(0), until - Date.now());
  listeners.forEach(listener => listener());
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const armed = () => armedUntil > 0;

/** Esc twice stops a running ROS; one Esc only arms Stop. Pass null when nothing is running. Returns whether Stop is armed. */
export function useEscToStop(stop: (() => void) | null): boolean {
  const latest = useRef(stop); latest.current = stop;
  const running = Boolean(stop);
  useEffect(() => {
    if (!running) { setArmed(0); return; }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat) return;
      if (armedUntil > Date.now()) { event.preventDefault(); setArmed(0); latest.current?.(); return; }
      // Esc in a dialog or a code editor belongs to them.
      if (document.querySelector('.modal, .cm-editor:focus-within')) return;
      // Arm once every handler has seen this Esc, unless one used it to close its own menu.
      window.setTimeout(() => { if (!event.defaultPrevented && latest.current) setArmed(Date.now() + ESC_STOP_WINDOW_MS); });
    };
    // Capture, so the dialog check runs before another handler closes the dialog.
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [running]);
  return useSyncExternalStore(subscribe, armed);
}

/** Stop for a running ROS. After one Esc it widens, turns red and asks for a second Esc for a few seconds. */
export function StopButton({ armed, onStop }: { armed: boolean; onStop: () => void }) {
  return <>
    <span className="sr-only" role="status">{armed ? 'Press Escape again to stop ROS' : ''}</span>
    <button type="button" className={`ros-send ros-stop ${armed ? 'armed' : ''}`} aria-label="Stop ROS" title="Stop (click, or Esc twice)" onClick={onStop}><Square size={10} fill="currentColor"/><span className="ros-stop-label" aria-hidden="true">Esc again to stop</span><span className="ros-stop-drain" aria-hidden="true"/></button>
  </>;
}
