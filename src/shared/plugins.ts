/** Tools outside ros.ai that a person can connect with something they already have (a token or key).
 * Connecting only saves and checks access; using a plugin from the canvas or assistant comes later.
 */
export type TokenPluginId = 'zotero' | 'slack' | 'notion' | 'github';
export type PluginId = TokenPluginId | 'google-drive' | 'google-docs' | 'tavily' | 'exa' | 'brave' | 'overleaf' | 'linear' | 'sentry' | 'figma';

export type PluginDefinition = {
  id: PluginId;
  name: string;
  summary: string;
  /** token: a pasted key or token kept on this computer; google: the Google Drive sign-in; key: an existing ros.ai key connection;
   * sign-in: the app's hosted MCP server, signed in from the browser; desktop: the MCP server of the app's desktop program
   * on this computer; unavailable: shown, not connectable yet. */
  connect: 'token' | 'google' | 'key' | 'sign-in' | 'desktop' | 'unavailable';
  tokenLabel?: string;
  tokenHint?: string;
  tokenLink?: string;
  /** The app has a hosted MCP server: Connect signs in there, like Claude does; a token stays as the fallback. */
  signIn?: boolean;
  unavailableReason?: string;
  /** desktop: how to turn on the app's server, and what the app needs for it. */
  start?: string;
  requirement?: string;
  /** Two or three bullets on the plugin's page: what agents can do with it. */
  uses?: string[];
};

export const PLUGINS: PluginDefinition[] = [
  { id: 'google-drive', uses: ['Browse the CSV files in your Drive and copy one into a project', 'Read your Google Docs as sources', 'Read-only: nothing in your Drive is changed'], name: 'Google Drive', summary: 'Browse CSV files and copy them into a project.', connect: 'google' },
  { id: 'google-docs', uses: ['Read your Google Docs as sources', 'Uses the Google Drive sign-in, nothing extra to connect'], name: 'Google Docs', summary: 'Read your Google Docs as sources.', connect: 'google' },
  { id: 'zotero', uses: ['Pull references and citations from your library', 'Cite sources in reports with the right details'], name: 'Zotero', summary: 'Your reference library and citations.', connect: 'token', tokenLabel: 'Zotero API key', tokenHint: 'Create a read-only key under Settings > Security > Applications in your Zotero account.', tokenLink: 'https://www.zotero.org/settings/security#applications' },
  { id: 'slack', uses: ['Agents read the channels your Slack app is in, and share findings there', 'Posts only after you accept the message', 'Uses the bot token of your own Slack app'], name: 'Slack', summary: 'Read your team’s channels and share findings there.', connect: 'token', tokenLabel: 'Slack bot token', tokenHint: 'Create a Slack app for your workspace with the bot scopes channels:read, channels:history, groups:read, groups:history, users:read and chat:write. Install it, copy its Bot User OAuth Token (xoxb-…), and invite the app to the channels agents may read.', tokenLink: 'https://api.slack.com/apps' },
  { id: 'notion', uses: ['Find answers in your pages and databases, from any block or from Ros', 'Bring a page or database onto the map', 'Save findings and reports back as pages, after you accept'], name: 'Notion', summary: 'Your pages and databases, through Notion’s own connection.', connect: 'token', signIn: true, tokenLabel: 'Notion integration secret', tokenHint: 'Create an internal integration, copy its secret, then share the pages you want with it.', tokenLink: 'https://www.notion.so/profile/integrations' },
  { id: 'github', uses: ['Agents read repositories, issues and pull requests through GitHub’s own tools', 'Opening an issue or a pull request waits for you to accept', 'Uses the token you save here'], name: 'GitHub', summary: 'Repositories, issues and pull requests.', connect: 'token', tokenLabel: 'GitHub personal access token', tokenHint: 'Create a fine-grained token with read access to the repositories you choose. Give it write access to issues or pull requests only if agents may open them, after you accept.', tokenLink: 'https://github.com/settings/personal-access-tokens' },
  { id: 'linear', uses: ['Agents find and read issues, projects and comments', 'Creating or changing an issue waits for you to accept', 'Sign in to Linear once; nothing to create or paste'], name: 'Linear', summary: 'Issues and projects, through Linear’s own connection.', connect: 'sign-in' },
  { id: 'sentry', uses: ['Agents read issues, events and traces from your projects', 'Changing an issue waits for you to accept', 'Sign in to Sentry once; nothing to create or paste'], name: 'Sentry', summary: 'Errors and traces, through Sentry’s own connection.', connect: 'sign-in' },
  { id: 'figma', uses: ['Agents read the frames you link or select: layout, styles and variables', 'Runs through Figma’s desktop app on this computer', 'Anything that would change a file waits for you to accept'], name: 'Figma', summary: 'Designs, through Figma’s desktop app.', connect: 'desktop', start: 'In Figma’s desktop app, open a design file, switch to Dev Mode and turn on the desktop MCP server in the inspect panel. Then click Connect.', requirement: 'Figma’s desktop server needs a Dev or Full seat on a Professional, Organization or Enterprise plan. Figma’s hosted server admits only the apps on its own list, which is closed to new ones for now.' },
  { id: 'tavily', uses: ['Web search for research you start', 'Each search counts against the allowance you set in Budget'], name: 'Tavily web search', summary: 'Web search for research you start.', connect: 'key' },
  { id: 'exa', uses: ['Web search that finds pages by what they mean, not only their words', 'Returns the passages of each page that answer the search, and reads whole pages', 'About US$0.007 a search and US$0.001 a page read'], name: 'Exa web search', summary: 'Web search that finds pages by meaning.', connect: 'key' },
  { id: 'brave', uses: ['Web search from Brave’s own index of the web', 'Returns the passages of each page that answer the search; it cannot read whole pages', 'About US$0.005 a search, with US$5 free each month'], name: 'Brave Search', summary: 'Web search from its own independent index.', connect: 'key' },
  { id: 'overleaf', uses: ['Write papers in LaTeX with your coauthors'], name: 'Overleaf', summary: 'Write papers in LaTeX with your coauthors.', connect: 'unavailable', unavailableReason: 'Overleaf has no public API. Its Git integration needs a paid Overleaf plan, so this waits for a later round.' },
];

export type PluginStatus = {
  id: TokenPluginId;
  configured: boolean;
  checkedAt: string | null;
  verified: boolean | null;
  checkMessage: string | null;
};

/** An app connected by signing in to its hosted MCP server. */
export type AppConnectionStatus = { id: string; name: string; connected: boolean; connectedAt: string | null; account: string | null };
