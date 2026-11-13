import { createHash } from 'node:crypto';
import type { AgentEvent } from '../shared/agent-runtime.js';

/** What Claude Code and Codex share about one turn: how long it may run, what the agent hears about that time while it
 * passes, and the line that says what the agent is doing while nothing else shows.
 *
 * At a high effort level an agent thinks for minutes between steps. The person then saw one unchanged line for that
 * long, and the agent, which sees no clock, went on researching until the limit cut it off with nothing on the map. */

/** One turn's wall time in seconds, for both agents. ROS_AGENT_TURN_SECONDS sets another. */
export const TURN_SECONDS = Math.min(4 * 3600, Math.max(20, Number(process.env.ROS_AGENT_TURN_SECONDS) || 1800));
/** Tools that go and look something up. In a turn's last minutes they are turned away, so what is left goes to writing. */
const LOOKUPS = new Set(['ros_fan_out_search', 'ros_read_pages', 'ros_check_claims', 'ros_search_posts', 'ros_browser', 'WebSearch', 'WebFetch']);
const minutes = (seconds: number) => { const value = Math.max(1, Math.round(seconds / 60)); return `${value} minute${value === 1 ? '' : 's'}`; };

/** The limit in words, as in "30 minutes". */
export const TURN_LIMIT = minutes(TURN_SECONDS);

/** For both agents' instructions: how long a turn has, and how to spend it. */
export const TURN_BRIEF = `A turn can run for about ${TURN_LIMIT}. ros.ai tells you when half of that time is gone and when little is left. Work in the open: when the work makes something to keep (search results, findings, notes, a report), put it on the map as you go rather than all at the end, so the researcher sees it take shape and nothing is lost if the time runs out.`;

/** The clock of one turn. The agent is told once when half of the time is gone and once when a fifth is left (note), and
 * in the last tenth, three minutes at most, a lookup is turned away (refusal). */
export function turnClock(seconds = TURN_SECONDS, startedAt = Date.now()) {
  const closing = Math.min(180, seconds / 10);
  let half = false, late = false;
  const left = () => seconds - (Date.now() - startedAt) / 1000;
  return {
    /** What is said now, if anything, each of the two notes once: tell is for the agent, shown is the step the person sees. */
    note(): { tell: string; shown: string } | null {
      const remaining = left();
      if (!late && remaining <= seconds / 5) {
        late = half = true;
        return { tell: `[ros.ai] This turn has about ${minutes(remaining)} left. Stop gathering: write what you have to the map if it belongs there, then answer and say what is still open.`, shown: `This turn has about ${minutes(remaining)} left; ros.ai told the agent to finish.` };
      }
      if (!half && remaining <= seconds / 2) {
        half = true;
        return { tell: `[ros.ai] Half of this turn's time is used (${minutes(seconds - remaining)} of ${minutes(seconds)}). If your work belongs on the map, put what you have there now and go on from it; do not save it all for the end.`, shown: 'Half of this turn’s time is used; ros.ai told the agent to put what it has on the map.' };
      }
      return null;
    },
    /** Why a tool is turned away in the turn's last minutes; nothing when it may run. */
    refusal(tool: string): string | null {
      return LOOKUPS.has(tool) && left() <= closing ? 'This turn’s time is nearly up, so ros.ai did not start this lookup. Write what you have to the map if it belongs there, then answer and say what is still open; the researcher can send "continue".' : null;
    },
  };
}
export type TurnClock = ReturnType<typeof turnClock>;

/** The status line of a running turn, as 'status' events: at most one a second, and only when it says something new. */
export function statusLine(onEvent: (event: AgentEvent) => void, everyMs = 1000) {
  let said = '', next: string | null = null, at = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const send = () => {
    timer = undefined;
    if (next === null || next === said) { next = null; return; }
    said = next; next = null; at = Date.now();
    onEvent({ at: new Date().toISOString(), type: 'status', message: said });
  };
  return {
    say(message: string) { next = message; if (timer) return; const wait = at + everyMs - Date.now(); if (wait <= 0) send(); else timer = setTimeout(send, wait); },
    /** A step was recorded and shows instead, or the turn ended: what waited is dropped, and the same words may be said again. */
    clear() { clearTimeout(timer); timer = undefined; next = null; said = ''; },
  };
}

const cut = (value: string, length: number) => {
  if (value.length <= length) return value;
  const space = value.lastIndexOf(' ', length);
  return `${value.slice(0, space > length / 2 ? space : length).trimEnd()}…`;
};
/** A status line from the thinking a model shows. Codex's summaries carry a bold headline for each part, and the newest
 * is the line. Plain thinking gives its last finished sentence, or its first words while the first sentence is still coming.
 * Thinking that is not shown has only a running count of its tokens, when the agent reports one. */
export function thinkingLine(text: string, tokens = 0): string {
  const headline = [...text.matchAll(/\*\*([^*\n]{2,140})\*\*/gu)].at(-1)?.[1]?.trim();
  if (headline) return `Thinking: ${headline}`;
  const plain = text.replace(/[*_`#>]+/gu, '').replace(/\s+/gu, ' ').trim();
  if (!plain) return tokens >= 100 ? `Thinking… ${(Math.round(tokens / 100) * 100).toLocaleString('en-US')} tokens so far` : 'Thinking…';
  const sentences = plain.split(/(?<=[.!?…])\s+/u), last = sentences.at(-1)!;
  return `Thinking: ${cut(/[.!?…]$/u.test(last) ? last : sentences.at(-2) ?? last, 140)}`;
}

/** Every step of a turn sends the agent's whole conversation again. The model's provider keeps it cached, so a step pays
 * a fraction for the part it has seen, but only for a while (an hour for Claude Code on a plan, less at OpenAI), and
 * writing it into Claude's cache costs more than reading it fresh. A thread's session used to be picked up for every
 * message, for days: one Claude Code session grew to 138,000 tokens over ten turns, each of its 42 steps read it all, and
 * after each break it was written again in full. Past an hour, or once it is long, a thread starts a new session that is
 * told the conversation so far in writing (AgentExecuteRequest.earlier); the canvas holds the work itself. */
export const RESUME_MAX_IDLE_MS = 55 * 60_000;
/** A finished turn's session is carried on up to this length in tokens; "continue" after a stopped turn, which needs what
 * the stopped turn had read, up to the larger one. */
export const RESUME_MAX_TOKENS = 60_000, CONTINUE_MAX_TOKENS = 150_000;
/** What a thread keeps of its agent session to decide this. at: when its last turn ended. tokens: the conversation's
 * length at its last request, when the agent reports it. ended: whether that turn finished rather than stopping part way. */
export type SessionUse = { at: string; tokens?: number; ended?: boolean };
/** Why a thread's saved session is not picked up again, or null when it is. */
export function staleSession(session: SessionUse, at = Date.now()): 'idle' | 'long' | null {
  if (at - Date.parse(session.at) > RESUME_MAX_IDLE_MS) return 'idle';
  if ((session.tokens ?? 0) > (session.ended === false ? CONTINUE_MAX_TOKENS : RESUME_MAX_TOKENS)) return 'long';
  return null;
}
/** The step that says why the agent starts a new session. */
export function freshSessionStep(agent: string, why: 'idle' | 'long', tokens = 0) {
  return why === 'idle' ? `More than an hour has passed, so ${agent} starts a new session with the conversation so far in writing, rather than reloading the old one in full.`
    : `This thread’s ${agent} session reached about ${Math.round(tokens / 1000)}k tokens, so it starts a new one with the conversation so far in writing; every step would read the whole session again.`;
}
/** The person's saved preferences and skill list go with every message. A session that already holds them, unchanged,
 * is told so in one line rather than given them again, turn after turn. */
export const preferencesKey = (preferences: string | undefined) => preferences ? createHash('sha256').update(preferences).digest('hex').slice(0, 16) : undefined;
export const SAME_PREFERENCES = 'The researcher’s saved preferences and skills, given earlier in this conversation, still apply unchanged.';
