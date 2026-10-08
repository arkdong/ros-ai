/** One connection from the person's own agent (Claude Code, Codex or another MCP client). */
export type OutsideSession = { id: string; label: string; startedAt: string; lastAt: string; cwd?: string; projectId?: string; projectTitle?: string };
export type OutsideAgentsStatus = { bridge: string; commands: { claude: string; codex: string }; sessions: OutsideSession[]; activity: Record<string, string> };
