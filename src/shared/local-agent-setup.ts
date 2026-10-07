/** Setup/authentication is distinct from permission to execute a research turn. */
export type LocalAgentId = 'codex';
export type LocalAgentSetup = {
  id: LocalAgentId; label: string; checkedAt: string;
  authentication: 'native-chatgpt';
  installed: boolean; version: string | null; signedIn: boolean;
  cliSignedIn: boolean; rpcSignedIn: boolean | null;
  protocolConfigured: boolean; isolationReady: boolean;
  authorized: boolean; available: boolean; noInference: true;
  detail: string; blockers: string[]; steps: string[];
  commands: { label: string; command: string }[];
  links: { label: string; url: string }[];
};
export type CodexLoginStatus = {
  id: string; agent: 'codex'; method: 'browser' | 'device';
  state: 'waiting' | 'completed' | 'failed' | 'cancelled' | 'expired';
  authUrl?: string; userCode?: string; expiresAt: string; message: string;
};
