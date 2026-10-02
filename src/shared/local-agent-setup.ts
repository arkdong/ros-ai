/** Setup/authentication is distinct from permission to execute a research turn. */
export type LocalAgentId = 'codex' | 'claude';
export type LocalAgentSetup = {
  id: LocalAgentId; label: string; checkedAt: string;
  authentication: 'native-chatgpt' | 'anthropic-api-key';
  installed: boolean; version: string | null; signedIn: boolean;
  cliSignedIn: boolean; rpcSignedIn: boolean | null;
  apiKeyConfigured: boolean; apiAuthenticationSelected: boolean; apiCredentialVerified: boolean;
  protocolConfigured: boolean; runtimeImplemented: boolean; isolationReady: boolean;
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
