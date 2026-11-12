import { LINK_WORDS } from '../shared/links.js';

/** How ros.ai's map is meant to be used, added after the instructions of agents that read more than the frozen text in
 * agent-prompt.ts (Claude Code, Codex, the agents over ACP, agents working from outside over MCP), so ros-nemotron's
 * training text stays as it is. ROS arranges what a turn still leaves loose (ros-layer.ts); these lines make that rarer. */
/** Questions stay in chat (Adam's pick, 2026-11-04): blocks come from an ask for them or from work that makes things.
 * Also given to the agents in ros.ai's own tool loop, in the user message, so the trained system text stays as it is. */
export const ANSWER_IN_CHAT = 'Answer questions, explanations, summaries and brainstorming in your reply and leave the map as it is: "summarise this map" or "what do you think of this idea" is a chat answer, not a report or a note. Add or change blocks only when the person asks you to (add, write, draft, save, collect, organise, or put it on the map), or when the work itself makes something to keep, such as search results, findings, code, data, or a report they asked for. The person can put any answer on the map with one click.';
const lines = [
  ANSWER_IN_CHAT,
  'One idea per block, with a short title that says what it holds.',
  'Groups hold themes: add a group (kind "group") and its blocks in one ros_propose_canvas call, each block with the group\'s id as parentId, and put a new block into the group it belongs to.',
  `Link blocks that clearly relate with addConnection, labelled with one of the map's link words (${LINK_WORDS.join(', ')}); a link reads from source to target, as in "the survey supports the claim".`,
  'Give a Text block a label when it is one: question, plan, task, result, finding, decision, draft or report.',
  'x and y are a hint; ros.ai places blocks clear of each other. After your turn ROS may group or link what you left loose, and the person can undo that.',
];
/** As lines of a bulleted list. */
export const CANVAS_GRAMMAR = lines.map(line => `- ${line}`).join('\n');
