import { AsyncLocalStorage } from 'node:async_hooks';

/** The assistant turn whose work is running. A turn's tools write to the canvas themselves (a search's sources, saved
 * findings, a claim check, a browser log) and also propose changes for the person to accept. The store gives every
 * proposal made inside a turn the turn as its batch, and after each canvas write made inside a turn it re-checks that
 * turn's waiting proposals on the new canvas, so the turn's own work does not leave its changes out of date. */
const turns = new AsyncLocalStorage<string>();
/** Turns with work running now. A callback that outlives its turn (a timer, a process the turn started) keeps the
 * context, but no longer counts as the turn once the turn's work has ended. */
const live = new Map<string, number>();

/** Runs a turn's work (a turn driven by ros.ai, or one tool call of an agent) as that turn. */
export async function inTurn<T>(turnId: string, work: () => Promise<T>): Promise<T> {
  live.set(turnId, (live.get(turnId) ?? 0) + 1);
  try { return await turns.run(turnId, work); }
  finally {
    const left = (live.get(turnId) ?? 1) - 1;
    if (left > 0) live.set(turnId, left); else live.delete(turnId);
  }
}

/** The turn the current code runs for, while that turn's work is running. */
export function currentTurn(): string | undefined {
  const turnId = turns.getStore();
  return turnId !== undefined && live.has(turnId) ? turnId : undefined;
}
