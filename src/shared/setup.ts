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
/** The context ros.ai's agent needs to work step by step: its tools and instructions, a few results and an answer. */
export const AGENT_CONTEXT_TOKENS = 16_384;
/** One model a local server offers, as the server itself describes it. context is the context the server gives the
 * model when that is known (set on the model, or read while it is loaded); maxContext is what it was trained for.
 * tools is false only when the server says the model cannot call tools. */
export type LocalModel = { id: string; context: number | null; maxContext: number | null; tools: boolean | null; embedding: boolean; bytes: number | null };
export type DetectedModel = { id: LocalModelId; label: string; endpoint: string; found: boolean; running: boolean; models: string[]; details: LocalModel[]; connectionId: string | null };
export type DetectedKey = { provider: string; label: string; source: 'environment' | 'saved' };
export type AppId = 'notion' | 'slack' | 'zotero' | 'github' | 'obsidian' | 'linear' | 'figma' | 'google-drive' | 'dropbox';
export type DetectedApp = { id: AppId; label: string; signals: string[]; usedBy: string[]; connected: boolean };
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
