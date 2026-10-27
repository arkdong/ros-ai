/** Agents that speak the Agent Client Protocol (ACP) and can work as Ros. Each runs on this computer
 * with its own sign-in; ros.ai starts it for a turn, gives it ros.ai's tools and refuses its others. */
export type AcpAgentId = 'gemini' | 'goose' | 'opencode';
export const ACP_AGENT_IDS: AcpAgentId[] = ['gemini', 'goose', 'opencode'];
export const isAcpAgent = (value: unknown): value is AcpAgentId => typeof value === 'string' && (ACP_AGENT_IDS as string[]).includes(value);

/** caption: the line under the agent's name in the Ros bar's menu. */
export const ACP_AGENTS: Record<AcpAgentId, { label: string; summary: string; caption: string; install: string; docs: string; signIn: string }> = {
  gemini: { label: 'Gemini CLI', summary: 'Google’s agent · this computer’s Gemini sign-in', caption: 'Your Google sign-in', install: 'npm install -g @google/gemini-cli', docs: 'https://github.com/google-gemini/gemini-cli', signIn: 'Run gemini once in a terminal and sign in with Google, or set GEMINI_API_KEY before starting ros.ai.' },
  goose: { label: 'Goose', summary: 'Block’s open agent · the model Goose is set up with', caption: 'Goose’s own model', install: 'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash', docs: 'https://block.github.io/goose/docs/getting-started/installation', signIn: 'Run goose configure once in a terminal to choose its model provider.' },
  opencode: { label: 'OpenCode', summary: 'Open agent · the providers OpenCode is signed in to', caption: 'OpenCode’s own providers', install: 'npm install -g opencode-ai', docs: 'https://opencode.ai/docs', signIn: 'Run opencode auth login once in a terminal, or keep its free models.' },
};

/** What ros.ai knows about one agent: found on this computer, and what its last check found.
 * A check starts the agent and opens a session without sending a prompt, so no model runs. */
export type AcpAgentStatus = {
  id: AcpAgentId; label: string; installed: boolean; path: string | null; version: string | null;
  checked: { at: string; ok: boolean; detail: string } | null;
  /** Why a turn cannot start now, in words for the person; null when it can. */
  blocker: string | null;
};
