/** How ros.ai's map is meant to be used, added after the instructions of agents that read more than the frozen text in
 * agent-prompt.ts (Claude Code, Codex, the agents over ACP, agents working from outside over MCP), so ros-nemotron's
 * training text stays as it is. ROS arranges what a turn still leaves loose (ros-layer.ts); these lines make that rarer. */
const lines = [
  'One idea per block, with a short title that says what it holds. A long answer belongs on the map as a few blocks, not in your reply.',
  'Groups hold themes: add a group (kind "group") and its blocks in one ros_propose_canvas call, each block with the group\'s id as parentId, and put a new block into the group it belongs to.',
  'Link blocks that build on each other with addConnection and a label of one or two words (informs, supports, contradicts, answers, next step).',
  'Give a Text block a label when it is one: question, plan, task, result, finding, decision, draft or report.',
  'x and y are a hint; ros.ai places blocks clear of each other. After your turn ROS may group or link what you left loose, and the person can undo that.',
];
/** As lines of a bulleted list, for Claude Code and the agents over ACP. */
export const CANVAS_GRAMMAR = lines.map(line => `- ${line}`).join('\n');
/** As running text, for Codex and the MCP server's instructions. */
export const CANVAS_GRAMMAR_TEXT = `How the map is meant to be used: ${lines.join(' ')}`;
