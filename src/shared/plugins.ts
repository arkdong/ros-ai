/** Tools outside ros.ai that a person connects with something they already have: a sign-in, an app on this computer,
 * or a token or key as the fallback.
 */
export type TokenPluginId = 'zotero' | 'slack' | 'notion' | 'github' | 'openalex' | 'umami' | 'railway';
export type PluginId = TokenPluginId | 'arxiv' | 'google-drive' | 'google-sheets' | 'google-docs' | 'tavily' | 'exa' | 'brave' | 'overleaf' | 'linear' | 'sentry' | 'figma' | 'browser' | 'google-maps';

export type PluginDefinition = {
  id: PluginId;
  name: string;
  summary: string;
  /** token: a pasted key or token kept on this computer; google: the Google Drive sign-in; key: an existing ros.ai key connection;
   * sign-in: the app's hosted MCP server, signed in from the browser; desktop: the MCP server of the app's desktop program
   * on this computer; public: a free public service the person always reaches, which a switch offers to every agent
   * (OpenAlex also takes an optional key); browser: the agents' browser, run by the Chrome or Edge on this computer;
   * unavailable: shown, not connectable yet. */
  connect: 'token' | 'google' | 'key' | 'sign-in' | 'desktop' | 'public' | 'browser' | 'unavailable';
  tokenLabel?: string;
  tokenHint?: string;
  tokenLink?: string;
  /** The app has a hosted MCP server: Connect signs in there, like Claude does; a token stays as the fallback. */
  signIn?: boolean;
  /** It connects through what is already on this computer (the GitHub CLI's sign-in, the Zotero app); a token stays as
   * the fallback, under More. */
  local?: PluginWay;
  unavailableReason?: string;
  /** desktop: how to turn on the app's server, and what the app needs for it. */
  start?: string;
  requirement?: string;
  /** Two or three bullets on the plugin's page: what agents can do with it. */
  uses?: string[];
};

export const PLUGINS: PluginDefinition[] = [
  { id: 'google-drive', uses: ['Show a Google Sheet or Doc live on the canvas, and copy CSV files into a project', 'Every agent can find and read your Sheets and Docs', 'Read-only: nothing in your Drive is changed'], name: 'Google Drive', summary: 'Your Sheets, Docs and CSV files, read-only.', connect: 'google' },
  { id: 'google-sheets', uses: ['Show a tab live on the canvas, and copy it into a Data block for SQL', 'Agents read your sheets a tab or a range at a time', 'Uses the Google Drive sign-in, nothing extra to connect'], name: 'Google Sheets', summary: 'Your sheets on the canvas and for agents.', connect: 'google' },
  { id: 'google-docs', uses: ['Show a doc live on the canvas', 'Agents find and read your Docs as sources', 'Uses the Google Drive sign-in, nothing extra to connect'], name: 'Google Docs', summary: 'Your docs on the canvas and for agents.', connect: 'google' },
  { id: 'zotero', uses: ['Add a paper from your library with Add block › Paper, with the PDF Zotero stores', 'Every agent can search your library and cite from it', 'Reads through the Zotero app on this computer; nothing in your library changes'], name: 'Zotero', summary: 'Your reference library and its PDFs.', connect: 'token', local: 'zotero-app', tokenLabel: 'Zotero API key', tokenHint: 'Create a key under Settings > Security > Applications in your Zotero account, with “Allow library access” on and write access off. PDFs come along when Zotero stores them (not through WebDAV).', tokenLink: 'https://www.zotero.org/settings/security#applications' },
  { id: 'openalex', uses: ['Add any paper with Add block › Paper; its open PDF becomes a File block agents read', 'Turn it on and every agent searches published research, with citation counts', 'Free; a free key raises the daily searches from about 100 to 1,000'], name: 'OpenAlex', summary: 'Published research, with open PDFs and citations.', connect: 'public', tokenLabel: 'OpenAlex API key', tokenHint: 'Optional. Without a key OpenAlex allows about 100 searches a day; a free key from your OpenAlex account allows about 1,000.', tokenLink: 'https://openalex.org/settings/api' },
  { id: 'arxiv', uses: ['Add a preprint with Add block › Paper; its PDF becomes a File block agents read', 'Turn it on and every agent searches arXiv', 'ros.ai waits three seconds between requests, as arXiv asks'], name: 'arXiv', summary: 'Preprints in physics, maths, computer science and more.', connect: 'public' },
  { id: 'slack', uses: ['Agents read the channels your Slack app is in, and share findings there', 'Posts only after you accept the message', 'Uses the bot token of your own Slack app'], name: 'Slack', summary: 'Read your team’s channels and share findings there.', connect: 'token', tokenLabel: 'Slack bot token', tokenHint: 'Create a Slack app for your workspace with the bot scopes channels:read, channels:history, groups:read, groups:history, users:read and chat:write. Install it, copy its Bot User OAuth Token (xoxb-…), and invite the app to the channels agents may read.', tokenLink: 'https://api.slack.com/apps' },
  { id: 'notion', uses: ['Find answers in your pages and databases, from any block or from ROS', 'Bring a page or database onto the map', 'Save findings and reports back as pages, after you accept'], name: 'Notion', summary: 'Your pages and databases, through Notion’s own connection.', connect: 'token', signIn: true, tokenLabel: 'Notion integration secret', tokenHint: 'Create an internal integration, copy its secret, then share the pages you want with it.', tokenLink: 'https://www.notion.so/profile/integrations' },
  { id: 'github', uses: ['Agents read repositories, issues and pull requests through GitHub’s own tools', 'Opening an issue or a pull request waits for you to accept', 'Uses the GitHub CLI’s sign-in on this computer; nothing to create or paste'], name: 'GitHub', summary: 'Repositories, issues and pull requests.', connect: 'token', local: 'github-cli', tokenLabel: 'GitHub personal access token', tokenHint: 'Create a fine-grained token with read access to the repositories you choose. Give it write access to issues or pull requests only if agents may open them, after you accept.', tokenLink: 'https://github.com/settings/personal-access-tokens' },
  { id: 'linear', uses: ['Agents find and read issues, projects and comments', 'Creating or changing an issue waits for you to accept', 'Sign in to Linear once; nothing to create or paste'], name: 'Linear', summary: 'Issues and projects, through Linear’s own connection.', connect: 'sign-in' },
  { id: 'sentry', uses: ['Agents read issues, events and traces from your projects', 'Changing an issue waits for you to accept', 'Sign in to Sentry once; nothing to create or paste'], name: 'Sentry', summary: 'Errors and traces, through Sentry’s own connection.', connect: 'sign-in' },
  { id: 'figma', uses: ['Agents read the frames you link or select: layout, styles and variables', 'Runs through Figma’s desktop app on this computer', 'Anything that would change a file waits for you to accept'], name: 'Figma', summary: 'Designs, through Figma’s desktop app.', connect: 'desktop', start: 'In Figma’s desktop app, open a design file, switch to Dev Mode and turn on the desktop MCP server in the inspect panel. Then click Connect.', requirement: 'Figma’s desktop server needs a Dev or Full seat on a Professional, Organization or Enterprise plan. Figma’s hosted server admits only the apps on its own list, which is closed to new ones for now.' },
  { id: 'tavily', uses: ['Web search for research you start', 'Free with no account, up to Tavily’s limit; a key of your own searches more'], name: 'Tavily web search', summary: 'Web search for research you start.', connect: 'key' },
  { id: 'exa', uses: ['Web search that finds pages by what they mean, not only their words', 'Returns the passages of each page that answer the search, and reads whole pages', 'Free with no account, up to Exa’s limit; with a key, about US$0.007 a search'], name: 'Exa web search', summary: 'Web search that finds pages by meaning.', connect: 'key' },
  { id: 'brave', uses: ['Web search from Brave’s own index of the web', 'Returns the passages of each page that answer the search; it cannot read whole pages', 'About US$0.005 a search, with US$5 free each month'], name: 'Brave Search', summary: 'Web search from its own independent index.', connect: 'key' },
  { id: 'google-maps', uses: ['Google Maps blocks show every pin at once on Google’s map; without a key, one place at a time', 'Agents put places on it by name or address', 'Google gives 10,000 map loads a month free; past that, about US$7 per 1,000'], name: 'Google Maps', summary: 'Google’s own map in Map blocks.', connect: 'key' },
  { id: 'browser', uses: ['Agents open websites, click through them and fill in forms', 'Screenshots land on the canvas as File blocks, and every step is listed there', 'A fresh browser each time: no cookies or logins, public websites only'], name: 'Browser', summary: 'Agents browse websites and take screenshots.', connect: 'browser' },
  { id: 'umami', uses: ['Show your website’s visitors, page views and tracked clicks in a Metrics block', 'Reads the numbers only; nothing on your site changes', 'Uses an API key from your Umami Cloud account'], name: 'Umami', summary: 'Your website’s visitors and clicks, for launch numbers.', connect: 'token', tokenLabel: 'Umami API key', tokenHint: 'Create a key under Settings › API keys in Umami Cloud. It reads the websites your account can see.', tokenLink: 'https://cloud.umami.is/settings/api-keys' },
  { id: 'railway', uses: ['Show whether each service of a Railway project is up, and when it last deployed, in a Metrics block', 'Reads only; it never deploys or changes anything', 'Uses an account token from your Railway settings'], name: 'Railway', summary: 'Whether your Railway services are up, for launch numbers.', connect: 'token', tokenLabel: 'Railway account token', tokenHint: 'Create a token under Account Settings › Tokens in Railway, with No workspace chosen so it can read your projects.', tokenLink: 'https://railway.com/account/tokens' },
  { id: 'overleaf', uses: ['Write papers in LaTeX with your coauthors'], name: 'Overleaf', summary: 'Write papers in LaTeX with your coauthors.', connect: 'unavailable', unavailableReason: 'Overleaf has no public API. Its Git integration needs a paid Overleaf plan, so this waits for a later round.' },
];

/** Connecting with what is already on this computer, as Codex and Claude Code do: github-cli, the GitHub CLI's sign-in
 * (`gh auth token`, read when needed and kept in memory only); zotero-app, the Zotero app's own local API. */
export type PluginWay = 'github-cli' | 'zotero-app';
/** How the Zotero app answers: ready (it lets other apps read the library), locked (the setting that allows it is off),
 * old (before Zotero 7, which has no local API) or closed (not open on this computer). */
export type ZoteroApp = 'ready' | 'locked' | 'old' | 'closed';
/** What on this computer can connect a plugin with nothing to paste: the GitHub CLI installed and signed in, and how
 * the Zotero app answers. */
export type LocalPlugins = { github: boolean; zotero: ZoteroApp };
/** What the person does when the Zotero app does not let ros.ai read the library. */
export function zoteroAppProblem(state: ZoteroApp) {
  if (state === 'locked') return 'Zotero is open but does not let other apps read it yet. In Zotero, open Settings › Advanced and tick “Allow other applications on this computer to communicate with Zotero”, then try again.';
  if (state === 'old') return 'This Zotero is older than Zotero 7, the first that lets other apps read your library. Update Zotero, or use an API key under More.';
  return state === 'closed' ? 'Zotero is not open on this computer. Open Zotero, then try again.' : '';
}

/** via: connected through something on this computer, not a token; the token a person saved stays the fallback. */
export type PluginStatus = {
  id: TokenPluginId;
  configured: boolean;
  via: PluginWay | null;
  checkedAt: string | null;
  verified: boolean | null;
  checkMessage: string | null;
};

/** One sign-in of an app a person signs in to more than once (Notion: one workspace each). key: its name in ros.ai;
 * default: the account agents and blocks use first. */
export type AppAccountStatus = { key: string; name: string; email: string | null; connected: boolean; connectedAt: string | null; default: boolean };
/** An app connected by signing in to its hosted MCP server. account: the default account's name. accounts: every
 * account of an app that takes several, the default first. notice: what the last sign-in did besides connecting (it
 * renewed an account), for a short while after it. */
export type AppConnectionStatus = { id: string; name: string; connected: boolean; connectedAt: string | null; account: string | null; accounts?: AppAccountStatus[]; notice?: string };
