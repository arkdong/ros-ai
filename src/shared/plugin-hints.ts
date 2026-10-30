/** What in a message points at a plugin: a link to the app, or the app's name used for the app. ros.ai reads these
 * itself, on this computer and before the message is sent, so every agent gets the same suggestion whatever its
 * vendor, Local ROS included. Nothing here reaches a model. */
import { PLUGINS, type PluginDefinition, type PluginId } from './plugins.js';

/** linked: a link or an identifier names the app without doubt. named: the app's name, checked for double meanings. */
export type PluginSignal = 'linked' | 'named';
export type PluginMatch = { id: PluginId; signal: PluginSignal };

type Hint = {
  /** Links, with or without https://, that belong to the app; for paper sources also a DOI or an arXiv ID. */
  links?: RegExp[];
  /** Spellings that only ever mean the app. */
  names?: string[];
  /** A name that is also an ordinary word ("linear regression", "slack time", "the notion of"). It counts right before
   * one of next ("Linear issues"), or capitalised after "in", "on", "our", "the" and the like ("in Linear"), unless one
   * of not or a capitalised word follows ("in Linear Algebra", "in Linear Attention"). capitalised: next counts only
   * for the capitalised name ("Brave Search"). */
  word?: { name: string; next: string[]; not?: string[]; capitalised?: boolean };
  /** What the plugin reaches once connected, one line for the card. */
  reach: string;
};

const searchReach = 'Searches the web with your own key. Each search is charged to it.', freeReach = 'Searches the web, free with no account up to its limit, or with your own key.';
const HINTS: Partial<Record<PluginId, Hint>> = {
  linear: {
    links: [/\blinear\.app\b/iu],
    word: { name: 'Linear', next: ['issue', 'issues', 'ticket', 'tickets', 'project', 'projects', 'cycle', 'cycles', 'board', 'team', 'workspace', 'backlog', 'triage', 'milestone', 'milestones', 'sprint', 'sprints'],
      not: ['algebra', 'regression', 'regressions', 'model', 'models', 'modelling', 'modeling', 'programming', 'time', 'equation', 'equations', 'function', 'functions', 'combination', 'combinations', 'map', 'maps', 'mapping', 'mappings', 'transformation', 'transformations', 'system', 'systems', 'interpolation', 'approximation', 'layer', 'layers', 'probe', 'probes', 'classifier', 'classifiers', 'operator', 'operators', 'space', 'spaces', 'trend', 'trends', 'relationship', 'relationships', 'correlation', 'scale', 'growth', 'fit', 'order', 'progression', 'sequence', 'discriminant', 'least', 'mixed', 'kernel', 'optimization', 'optimisation'] },
    reach: 'Reads issues and projects. Changes wait for you.',
  },
  notion: {
    links: [/\bnotion\.(?:so|site|com)\/[\w-]/iu, /\b[\w-]+\.notion\.site\b/iu],
    word: { name: 'Notion', next: ['page', 'pages', 'database', 'databases', 'doc', 'docs', 'document', 'documents', 'workspace', 'wiki', 'note', 'notes', 'table', 'tables', 'teamspace', 'template', 'templates', 'calendar'], not: ['of'] },
    reach: 'Reads pages and databases. Saving waits for you.',
  },
  slack: {
    links: [/\b[\w-]+\.slack\.com\/(?:archives|client|messages)\//iu],
    word: { name: 'Slack', next: ['channel', 'channels', 'thread', 'threads', 'message', 'messages', 'dm', 'dms', 'workspace', 'conversation', 'conversations', 'post', 'posts', 'huddle', 'chat', 'chats', 'discussion', 'discussions'],
      not: ['time', 'variable', 'variables', 'off', 'water', 'tide', 'line', 'lines', 'space'] },
    reach: 'Reads the channels your Slack app is in. Posting waits for you.',
  },
  github: { links: [/\bgithub\.com\/[\w.-]+\/[\w.-]+/iu], names: ['GitHub'], reach: 'Reads repositories, issues and pull requests. Changes wait for you.' },
  sentry: { links: [/\b(?:[\w-]+\.)?sentry\.io\/\S/iu], names: ['Sentry'], reach: 'Reads issues, events and traces. Changes wait for you.' },
  figma: { links: [/\bfigma\.com\/(?:file|design|proto|board|slides|make)\//iu], names: ['Figma'], reach: 'Reads the frames you link or select. Changes wait for you.' },
  zotero: { links: [/\bzotero\.org\/(?:groups\/|[\w.-]+\/(?:items|collections)\b)/iu], names: ['Zotero'], reach: 'Reads your library and its PDFs. Nothing in it changes.' },
  // A DOI, as a doi.org link or written out (10.1038/…, doi:10.1038/…), names a paper OpenAlex finds.
  openalex: { links: [/\bopenalex\.org\/\S/iu, /\bdoi\.org\/10\.\d{4,9}\//iu, /(?<![\w./])10\.\d{4,9}\/[^\s"'<>]*\w/u], names: ['OpenAlex'], reach: 'Searches published research, with citation counts. Free.' },
  arxiv: { links: [/\barxiv\.org\/(?:abs|pdf|html)\//iu, /\barxiv:\s?\d{4}\.\d{4,5}/iu], names: ['arXiv'], reach: 'Searches preprints in physics, maths, computer science and more. Free.' },
  'google-drive': { links: [/\bdrive\.google\.com\//iu, /\bdocs\.google\.com\/(?:presentation|forms|file)\//iu], names: ['Google Drive', 'GDrive'], reach: 'Reads your Sheets, Docs and CSV files. Nothing in your Drive changes.' },
  'google-sheets': { links: [/\bdocs\.google\.com\/spreadsheets\//iu], names: ['Google Sheets', 'Google Sheet', 'Google spreadsheets', 'Google spreadsheet', 'GSheets', 'GSheet'], reach: 'Reads your sheets, a tab or a range at a time. Nothing changes.' },
  'google-docs': { links: [/\bdocs\.google\.com\/document\//iu], names: ['Google Docs', 'Google Doc', 'GDocs', 'GDoc'], reach: 'Reads your docs. Nothing changes.' },
  tavily: { names: ['Tavily'], reach: freeReach },
  exa: { word: { name: 'Exa', next: ['search', 'searches', 'api', 'web'] }, reach: freeReach },
  brave: { word: { name: 'Brave', next: ['search', 'api'], not: ['new', 'heart', 'soul', 'enough', 'face', 'one', 'ones', 'man', 'men', 'woman', 'women', 'people'], capitalised: true }, reach: searchReach },
};

/** Words before a capitalised name that show the app is meant: "in Linear", "on Slack", "our Notion", "the Notion spec". */
const BEFORE = new Set(['in', 'on', 'from', 'into', 'onto', 'to', 'via', 'using', 'with', 'through', 'inside', 'within', 'our', 'my', 'your', 'their', 'the']);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/ /gu, '\\s+');
// A name stands alone: not inside a longer word, an address or a handle (figma.com, @github, #slack).
const standalone = (names: string[]) => new RegExp(`(?<![\\w.@/#-])(?:${[...names].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![\\w-]|\\.[a-z])`, 'giu');
const names = new Map(Object.entries(HINTS).flatMap(([id, hint]) => [
  ...(hint.names ? [[`${id}:names`, standalone(hint.names)] as const] : []),
  ...(hint.word ? [[`${id}:word`, standalone([hint.word.name])] as const] : []),
]));

/** Where the app's name is used for the app, or -1. */
function named(id: PluginId, hint: Hint, text: string) {
  const plain = names.get(`${id}:names`);
  if (plain) { plain.lastIndex = 0; const found = plain.exec(text); if (found) return found.index; }
  const word = hint.word, pattern = names.get(`${id}:word`);
  if (!word || !pattern) return -1;
  pattern.lastIndex = 0;
  for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
    const capital = (value: string) => value[0] !== value[0].toLowerCase();
    const following = /^\s+([a-z]+)/iu.exec(text.slice(found.index + found[0].length))?.[1], next = following?.toLowerCase();
    const before = /([a-z']+)\s+$/iu.exec(text.slice(Math.max(0, found.index - 40), found.index))?.[1]?.toLowerCase();
    if (next && word.next.includes(next) && (capital(found[0]) || !word.capitalised)) return found.index;
    // A title ("Advances in Linear Attention") capitalises the next word too; the app's name is followed by an ordinary one.
    if (capital(found[0]) && before && BEFORE.has(before) && !(next && word.not?.includes(next)) && !(following && capital(following))) return found.index;
  }
  return -1;
}

/** The plugins a message points at, at most one match each: links first, then names, each in the order they appear. */
export function pluginMatches(text: string): PluginMatch[] {
  const found: (PluginMatch & { at: number })[] = [];
  for (const [id, hint] of Object.entries(HINTS) as [PluginId, Hint][]) {
    const linked = (hint.links ?? []).map(pattern => text.search(pattern)).filter(at => at >= 0);
    if (linked.length) { found.push({ id, signal: 'linked', at: Math.min(...linked) }); continue; }
    const at = named(id, hint, text);
    if (at >= 0) found.push({ id, signal: 'named', at });
  }
  return found.sort((a, b) => Number(a.signal === 'named') - Number(b.signal === 'named') || a.at - b.at).map(({ id, signal }) => ({ id, signal }));
}

export const pluginReach = (id: PluginId) => HINTS[id]?.reach ?? '';

/** One line on why the plugin helps this request: about the person's message, never praise for the plugin. */
export function suggestionReason(match: PluginMatch) {
  const name = PLUGINS.find(plugin => plugin.id === match.id)?.name ?? match.id;
  if (match.signal === 'named') return `Your message mentions ${name}.`;
  return match.id === 'openalex' || match.id === 'arxiv' ? 'To find the paper your message points to.' : `To read the ${name} link in your message.`;
}

/** How the person connects a plugin from a suggestion. switch: turn a public source on for agents; sign-in: the app's own
 * sign-in in a new window; key and token: a field in the card; setup: a one-time setup on the Plugins page (Google Drive and
 * the Sheets and Docs that ride on it, Figma's desktop server, the browser, and the plugins that connect through what is
 * on this computer: GitHub and Zotero). */
export type SuggestionConnect = 'switch' | 'sign-in' | 'key' | 'token' | 'setup';
export function suggestionConnect(plugin: PluginDefinition): SuggestionConnect | null {
  if (plugin.connect === 'unavailable') return null;
  if (plugin.connect === 'public') return 'switch';
  if (plugin.connect === 'sign-in' || plugin.signIn) return 'sign-in';
  if (plugin.local) return 'setup';
  if (plugin.connect === 'key') return 'key';
  if (plugin.connect === 'token') return 'token';
  return 'setup';
}

/** Whether agents can use a plugin now. off: a switch that is off for agents; failed: its sign-in expired or its key or token
 * failed the check. */
export type PluginReadiness = 'ready' | 'off' | 'missing' | 'failed';
/** A plugin the person asked not to see: in one project for a while (Not now), or everywhere (Don't suggest again). */
export type SilencedPlugin = { pluginId: PluginId; projectId: string | null; projectTitle: string | null; until: string | null; at: string };
export type SuggestionStatus = { enabled: boolean; plugins: Partial<Record<PluginId, PluginReadiness>>; silenced: SilencedPlugin[] };
/** How long Not now keeps a plugin out of a project's suggestions. */
export const NOT_NOW_DAYS = 7;
