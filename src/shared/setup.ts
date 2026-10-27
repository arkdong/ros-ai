/** First launch: what ros.ai found on this computer and the links it made for the person.
 * Detection reads existence, names and modification times, never credentials; every link is one
 * `ros-ai` entry in the agent's own settings, with a record here and an Undo. */
export type AgentId = 'claude-code' | 'codex' | 'cursor' | 'gemini-cli' | 'pi' | 'hermes';
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
export type AppId = 'notion' | 'linear' | 'sentry' | 'figma' | 'slack' | 'zotero' | 'github' | 'google-drive' | 'obsidian' | 'dropbox';
/** How an app connects from the first-run screen. sign-in: its own sign-in in a window; desktop: the server its desktop
 * app runs on this computer; token: a token or key typed into the row; setup: a one-time setup on the Plugins page. */
export type AppConnect = 'sign-in' | 'desktop' | 'token' | 'setup';
export type DetectedApp = {
  id: AppId;
  label: string;
  /** What showed it is here: 'app', 'open' (Zotero answers), 'server on' (Figma's desktop server answers), 'synced folder',
   * 'signed in on the command line'. */
  signals: string[];
  /** The agents and other AI apps on this computer whose MCP servers already reach it. */
  usedBy: string[];
  /** When it was last used, read from the dates of its own folders. */
  used: 'today' | 'this week' | 'this month' | null;
  /** Figma: its desktop server answers. Zotero: the app is open. */
  running: boolean;
  connected: boolean;
  /** null: nothing to connect yet, so it is only named in the "Found on this computer" menu. */
  connect: AppConnect | null;
  /** Switched on at the start: a sign-in app used in the last 30 days or already reached by an agent, or a desktop server
   * that answers. Apps needing a token never are. */
  suggested: boolean;
};
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
  /** The tools card has something to offer: an agent, a running model server or an app to connect. */
  offer: boolean;
  /** Show the tools card by itself: it has not been seen and it has something to offer. */
  show: boolean;
};
export type LinkResult = { agent: AgentId; ok: boolean; message: string; command?: string; link: LinkRecord | null };
export type ModelLinkResult = { id: LocalModelId; ok: boolean; message: string; connectionId?: string };
export type SetupLinkRequest = { agents?: AgentId[]; models?: LocalModelId[] };
export type SetupLinkResponse = { agents: LinkResult[]; models: ModelLinkResult[] };
/** Reset onboarding, for testing the first run again: what each option would undo on this computer. localRos: Ros on
 * this computer is downloaded, or downloading. */
export type SetupResetPlan = { links: string[]; apps: string[]; tokens: string[]; cloud: boolean; localRos: boolean };
export type SetupResetRequest = { links?: boolean; apps?: boolean; tokens?: boolean; cloud?: boolean; localRos?: boolean };
/** done and failed: one line each, for the person. */
export type SetupResetResponse = { done: string[]; failed: string[] };
