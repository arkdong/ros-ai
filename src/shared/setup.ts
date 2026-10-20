/** First launch: what ros.ai found on this computer and the links it made for the person.
 * Detection reads existence, names and modification times, never credentials; every link is one
 * `ros-ai` entry in the agent's own settings, with a record here and an Undo. */
export type AgentId = 'claude-code' | 'codex' | 'cursor' | 'gemini-cli';
export type LinkMethod = 'cli' | 'file';
export type LinkRecord = { agent: AgentId; method: LinkMethod; target: string; bridge: string; writtenAt: string; backup?: string };
export type DetectedAgent = {
  id: AgentId;
  label: string;
  /** How the agent introduces itself to ros.ai's MCP server, which ties sessions to this row. */
  sessionLabel: string;
  found: boolean;
  /** Short facts for the row, strongest first: 'used recently', 'signed in', 'app', 'command line'. */
  signals: string[];
  signedIn: boolean | null;
  method: LinkMethod;
  /** ros.ai can write the link itself: the command line is reachable, or the settings file can take one entry. */
  linkable: boolean;
  /** A `ros-ai` entry already sits in the agent's settings, read by name only. */
  entry: boolean;
  link: LinkRecord | null;
  seenAt: string | null;
  seenIn: string | null;
  /** The command to paste, or for a settings file the entry to add. */
  command: string;
  /** The settings file the link lives in, shown with ~ for the home folder. */
  target: string;
  note?: string;
  /** Other MCP server names in its settings: hints for the apps the person already uses from an agent. */
  servers: string[];
};
export type LocalModelId = 'ollama' | 'lm-studio';
export type DetectedModel = { id: LocalModelId; label: string; endpoint: string; found: boolean; running: boolean; models: string[]; connectionId: string | null };
export type DetectedKey = { provider: string; label: string; source: 'environment' | 'saved' };
export type AppId = 'notion' | 'slack' | 'zotero' | 'github' | 'obsidian' | 'linear' | 'figma' | 'google-drive' | 'dropbox';
/** `connectable` apps have a hosted connection ros.ai can sign in to from the screen; the rest are only listed. */
export type DetectedApp = { id: AppId; label: string; signals: string[]; usedBy: string[]; connected: boolean; connectable: boolean; account: string | null };
export type SetupStatus = {
  seenAt: string | null;
  scannedAt: string;
  platform: string;
  /** 'this Mac', 'this PC' or 'this computer', for the screen's wording. */
  computer: string;
  /** What the scan looked at, for the line under the screen. */
  lookedAt: string[];
  bridge: string;
  agents: DetectedAgent[];
  models: DetectedModel[];
  keys: DetectedKey[];
  apps: DetectedApp[];
  docker: { found: boolean; running: boolean };
  cloud: { available: boolean; signedIn: boolean };
  /** Show the first-launch screen: it has not been seen and an agent or a running model server was found. */
  show: boolean;
};
export type LinkResult = { agent: AgentId; ok: boolean; message: string; command?: string; link: LinkRecord | null };
export type ModelLinkResult = { id: LocalModelId; ok: boolean; message: string; connectionId?: string };
export type SetupLinkRequest = { agents?: AgentId[]; models?: LocalModelId[] };
export type SetupLinkResponse = { agents: LinkResult[]; models: ModelLinkResult[] };
