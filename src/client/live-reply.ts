import { useEffect, useRef, useState } from 'react';
import type { AssistantLive, AssistantState } from '../shared/assistant';

/** Running turns as the server streams them; a turn that ends calls onSettled so its actions and proposals load at once. */
export function useLiveTurns(projectId: string | null, enabled: boolean, onSettled: () => void) {
  const [live, setLive] = useState<Record<string, AssistantLive>>({});
  const settled = useRef(onSettled);
  settled.current = onSettled;
  useEffect(() => { setLive({}); }, [projectId]);
  useEffect(() => {
    if (!projectId || !enabled || typeof EventSource === 'undefined') return;
    const events = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/assistant/events`), seen = new Set<string>();
    events.onmessage = item => {
      let value: AssistantLive;
      try { value = JSON.parse(item.data) as AssistantLive; } catch { return; }
      setLive(current => ({ ...current, [value.turnId]: value }));
      // A turn that ends, and one that starts on its own (a waiting message sent once its thread was free), load at once.
      const fresh = !seen.has(value.turnId); seen.add(value.turnId);
      if (value.status !== 'running' || fresh) settled.current();
    };
    return () => events.close();
  }, [projectId, enabled]);
  return live;
}

/** The saved state with streamed text laid over it, only where the stream is ahead of the last refresh. */
export function withLive(state: AssistantState | null, live: Record<string, AssistantLive>): AssistantState | null {
  if (!state) return state;
  let changed = false;
  const turns = state.turns.map(turn => {
    const value = live[turn.id];
    if (!value || turn.status !== 'running' || value.reply.length <= turn.reply.length) return turn;
    changed = true;
    return { ...turn, reply: value.reply, events: value.step && value.step !== turn.events.at(-1)?.message ? [...turn.events, { at: new Date().toISOString(), message: value.step }] : turn.events };
  });
  return changed ? { ...state, turns } : state;
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Reveals text a little each frame instead of in lumps. The pace follows the backlog: a long burst
 * catches up quickly, a slow stream reads word by word, and the rest of a finished reply follows within
 * about half a second. Text that was already there when the turn first showed (an old reply) appears in full.
 */
export function useSmoothText(target: string, animate: boolean) {
  const [shown, setShown] = useState(() => animate ? 0 : target.length);
  const length = useRef(shown);
  const watched = useRef(animate), running = useRef(animate);
  if (animate) watched.current = true;
  running.current = animate;
  useEffect(() => {
    if (!watched.current || reducedMotion()) { length.current = target.length; setShown(target.length); return; }
    if (length.current > target.length) { length.current = target.length; setShown(target.length); }
    let frame = 0, last = 0;
    const step = (at: number) => {
      const backlog = target.length - length.current;
      if (backlog <= 0) return;
      // About 30 updates a second keeps Markdown rendering cheap and still reads as continuous.
      if (at - last >= 32) {
        last = at;
        let next = length.current + Math.max(3, Math.ceil(backlog / (running.current ? 8 : 4)));
        const space = target.indexOf(' ', next);
        if (space !== -1 && space - next < 12) next = space;
        length.current = Math.min(target.length, next);
        setShown(length.current);
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown >= target.length ? target : target.slice(0, shown);
}
