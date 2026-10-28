import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginMatches, suggestionConnect, suggestionReason } from '../src/shared/plugin-hints.js';
import { PLUGINS, type PluginId } from '../src/shared/plugins.js';

const ids = (text: string) => pluginMatches(text).map(match => `${match.id}:${match.signal}`);

test('a link names its app, with or without https://', () => {
  assert.deepEqual(ids('Triage the open bugs in linear.app/aiso/project/q4-research'), ['linear:linked']);
  assert.deepEqual(ids('Summarise https://www.notion.so/aiso/Hiring-plan-2b1f0c'), ['notion:linked']);
  assert.deepEqual(ids('Read https://aiso.notion.site/Public-notes'), ['notion:linked']);
  assert.deepEqual(ids('What did we decide in https://aiso.slack.com/archives/C04/p1712'), ['slack:linked']);
  assert.deepEqual(ids('Which PRs touch github.com/arkdong/ros-ai this week?'), ['github:linked']);
  assert.deepEqual(ids('Check https://aiso.sentry.io/issues/4211/'), ['sentry:linked']);
  assert.deepEqual(ids('Compare with https://www.figma.com/design/AbC123/Onboarding'), ['figma:linked']);
  assert.deepEqual(ids('Plot docs.google.com/spreadsheets/d/1xYz/edit'), ['google-sheets:linked']);
  assert.deepEqual(ids('Turn docs.google.com/document/d/1xYz/edit into notes'), ['google-docs:linked']);
  assert.deepEqual(ids('Open drive.google.com/drive/folders/1xYz'), ['google-drive:linked']);
});

test('a DOI or an arXiv ID names a paper source', () => {
  assert.deepEqual(ids('Summarise 10.1038/s41586-021-03819-2 for me'), ['openalex:linked']);
  assert.deepEqual(ids('See https://doi.org/10.1145/3442188.3445922.'), ['openalex:linked']);
  assert.deepEqual(ids('Is arXiv:2310.06825 peer reviewed?'), ['arxiv:linked']);
  assert.deepEqual(ids('Read https://arxiv.org/abs/1706.03762'), ['arxiv:linked']);
  assert.deepEqual(ids('Version 10.2 shipped; ratio 10.5 / 3'), []);
});

test('a name counts when it can only mean the app', () => {
  assert.deepEqual(ids('Find the papers in my Zotero library on heat islands'), ['zotero:named']);
  assert.deepEqual(ids('Search OpenAlex for urban heat'), ['openalex:named']);
  assert.deepEqual(ids('Anything new on arxiv about diffusion?'), ['arxiv:named']);
  assert.deepEqual(ids('Open the issue on GitHub'), ['github:named']);
  assert.deepEqual(ids('What does Sentry say about the crash?'), ['sentry:named']);
  assert.deepEqual(ids('Use Tavily for this'), ['tavily:named']);
  assert.deepEqual(ids('Chart the Google Sheet we use for sign-ups'), ['google-sheets:named']);
  assert.deepEqual(ids('Our Google Drive has the raw files'), ['google-drive:named']);
});

test('a name that is also a word counts only where it means the app', () => {
  assert.deepEqual(ids('List the open issues in our Linear project'), ['linear:named']);
  assert.deepEqual(ids('which linear tickets are blocked?'), ['linear:named']);
  assert.deepEqual(ids('What we said in Slack last week'), ['slack:named']);
  assert.deepEqual(ids('Post it to the slack channel'), ['slack:named']);
  assert.deepEqual(ids('The spec in Notion that Sam wrote'), ['notion:named']);
  assert.deepEqual(ids('In Notion, find the hiring plan'), ['notion:named']);
  assert.deepEqual(ids('Search the web with Brave'), ['brave:named']);
  assert.deepEqual(ids('Try Brave Search first'), ['brave:named']);
  assert.deepEqual(ids('Is Exa search better for this?'), ['exa:named']);
});

test('ordinary words with an app’s name are left alone', () => {
  for (const text of [
    'Fit a linear regression on the cycling data',
    'This runs in linear time',
    'A course on Linear Algebra',
    'In Linear Regression, the residuals should be normal',
    'Linear models underfit here',
    'Cut me some slack on the deadline',
    'Add slack variables to the LP',
    'There is slack in the schedule',
    'The notion of fairness differs by field',
    'I have no notion of how this works',
    'Be brave and drop the outliers',
    'A brave search party set out',
    'Read Brave New World',
    'Exa-scale computing needs new tools',
    'Pricing is on figma.com/pricing',
    'Advances in Linear Attention for long contexts',
    'Efficient Linear Attention beats softmax here',
    'Picking up the slack after the move',
  ]) assert.deepEqual(ids(text), [], text);
});

test('one match per plugin, links before names', () => {
  assert.deepEqual(ids('Compare the Notion spec with linear.app/aiso/issue/ENG-12'), ['linear:linked', 'notion:named']);
  assert.deepEqual(ids('github.com/arkdong/ros-ai has GitHub issues open'), ['github:linked']);
  assert.deepEqual(ids('Cite Zotero items and arXiv:2310.06825'), ['arxiv:linked', 'zotero:named']);
});

test('the card says why in words about the message, and how each plugin connects', () => {
  assert.equal(suggestionReason({ id: 'linear', signal: 'linked' }), 'To read the Linear link in your message.');
  assert.equal(suggestionReason({ id: 'linear', signal: 'named' }), 'Your message mentions Linear.');
  assert.equal(suggestionReason({ id: 'openalex', signal: 'linked' }), 'To find the paper your message points to.');
  const kind = (id: PluginId) => suggestionConnect(PLUGINS.find(plugin => plugin.id === id)!);
  assert.deepEqual(['linear', 'sentry', 'notion', 'openalex', 'arxiv', 'tavily', 'zotero', 'github', 'slack', 'google-drive', 'google-sheets', 'figma', 'browser', 'overleaf'].map(id => kind(id as PluginId)),
    ['sign-in', 'sign-in', 'sign-in', 'switch', 'switch', 'key', 'token', 'token', 'token', 'setup', 'setup', 'setup', 'setup', null]);
});
