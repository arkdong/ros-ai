/** Tools outside ros.ai that a person can connect with something they already have (a token or key).
 * Connecting only saves and checks access; using a plugin from the canvas or assistant comes later.
 */
export type TokenPluginId = 'zotero' | 'slack' | 'notion' | 'github';
export type PluginId = TokenPluginId | 'google-drive' | 'google-docs' | 'tavily' | 'overleaf';

export type PluginDefinition = {
  id: PluginId;
  name: string;
  summary: string;
  /** token: a pasted key or token kept on this computer; google: the Google Drive sign-in; key: an existing ros.ai key connection; unavailable: shown, not connectable yet. */
  connect: 'token' | 'google' | 'key' | 'unavailable';
  tokenLabel?: string;
  tokenHint?: string;
  tokenLink?: string;
  unavailableReason?: string;
};

export const PLUGINS: PluginDefinition[] = [
  { id: 'google-drive', name: 'Google Drive', summary: 'Browse CSV files and copy them into a project.', connect: 'google' },
  { id: 'google-docs', name: 'Google Docs', summary: 'Read your Google Docs as sources.', connect: 'google' },
  { id: 'zotero', name: 'Zotero', summary: 'Your reference library and citations.', connect: 'token', tokenLabel: 'Zotero API key', tokenHint: 'Create a read-only key under Settings > Security > Applications in your Zotero account.', tokenLink: 'https://www.zotero.org/settings/security#applications' },
  { id: 'slack', name: 'Slack', summary: 'Share findings with your team’s channels.', connect: 'token', tokenLabel: 'Slack bot token', tokenHint: 'Create a Slack app for your workspace, install it, and copy its Bot User OAuth Token (xoxb-…).', tokenLink: 'https://api.slack.com/apps' },
  { id: 'notion', name: 'Notion', summary: 'Pages and databases you share with ros.ai. Agents read them and write only after you accept.', connect: 'token', tokenLabel: 'Notion integration secret', tokenHint: 'Create an internal integration, copy its secret, then share the pages you want with it.', tokenLink: 'https://www.notion.so/profile/integrations' },
  { id: 'github', name: 'GitHub', summary: 'Repositories with your code and data.', connect: 'token', tokenLabel: 'GitHub personal access token', tokenHint: 'Create a fine-grained token with read access to the repositories you choose.', tokenLink: 'https://github.com/settings/personal-access-tokens' },
  { id: 'tavily', name: 'Tavily web search', summary: 'Web search for research you start.', connect: 'key' },
  { id: 'overleaf', name: 'Overleaf', summary: 'Write papers in LaTeX with your coauthors.', connect: 'unavailable', unavailableReason: 'Overleaf has no public API. Its Git integration needs a paid Overleaf plan, so this waits for a later round.' },
];

export type PluginStatus = {
  id: TokenPluginId;
  configured: boolean;
  /** Notion only: whether "Sign in with Notion" is set up, and the workspace of the current sign-in. */
  signIn?: { available: boolean; workspace?: string | null };
  checkedAt: string | null;
  verified: boolean | null;
  checkMessage: string | null;
};
