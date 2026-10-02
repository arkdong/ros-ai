export type CredentialProvider = 'nebius' | 'claude' | 'openai' | 'tavily';
export type CredentialStatus = {
  provider: CredentialProvider;
  configured: boolean;
  source: 'saved' | 'environment' | 'none';
  canDisconnect: boolean;
  checkedAt: string | null;
  verified: boolean | null;
  checkMessage: string | null;
};
