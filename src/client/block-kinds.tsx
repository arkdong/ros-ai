import type { ReactNode } from 'react';
import { AppWindow, Braces, Database, File as FileIcon, GraduationCap, LayoutGrid, MapPinned, NotebookPen, Text as TextIcon } from 'lucide-react';
import { BrandLogo } from './brand-logos';
import type { NodeKind } from '../shared/types';
import { readSaved, saveLocal } from './persistence';

export type KindId = 'text' | 'code' | 'notebook' | 'data' | 'file' | 'paper' | 'notion' | 'google' | 'app' | 'training' | 'map' | 'group';
export type NewBlockType = 'dataset' | 'code' | 'notebook' | 'report' | 'notion' | 'file' | 'google' | 'app' | 'training' | 'map';
export type KindGroup = 'Write' | 'Bring in' | 'Build';
/** One kind of block a person can add. `asks` kinds need something first (a file, a link, a paper), so they open the
 *  All blocks window; the others land on the map at once. `needs` names what must be in place, in the person's words. */
export type BlockKind = { id: KindId; name: string; caption: string; line: string; needs: string; facts: string[]; group: KindGroup; kind: NodeKind; blockType?: NewBlockType; asks?: boolean; localOnly?: boolean; icon: (size: number) => ReactNode };

export const BLOCK_KINDS: BlockKind[] = [
  { id: 'text', name: 'Text', caption: 'Write', group: 'Write', kind: 'topic', needs: 'Nothing', line: 'Notes, questions, drafts and decisions, written by you or filled by an agent. ROS can check its sources.', facts: ['Label it as a question, task or decision', 'Agents read it and fill it'], icon: size => <TextIcon size={size}/> },
  { id: 'code', name: 'Code', caption: 'Python', group: 'Write', kind: 'topic', blockType: 'code', needs: 'Python ready', line: 'Python that runs on this computer in ros.ai’s own sandbox. Data blocks on the map become inputs; a result can become a Data block.', facts: ['Reads Data blocks as inputs', 'Results can become Data'], icon: size => <Braces size={size}/> },
  { id: 'notebook', name: 'Notebook', caption: 'Cells', group: 'Write', kind: 'topic', blockType: 'notebook', needs: 'Python ready', line: 'Python cell by cell, with outputs kept beside the code. Opens a .ipynb as well.', facts: ['Starts from a .ipynb too', 'Outputs stay with their cells'], icon: size => <NotebookPen size={size}/> },
  { id: 'data', name: 'Data', caption: 'CSV, sheet', group: 'Bring in', kind: 'topic', blockType: 'dataset', needs: 'Nothing', line: 'A CSV you drop in or a sheet you link, shown as a table and readable by Code, Notebook and agents.', facts: ['Drop a CSV on the card', 'Code and agents read it'], icon: size => <Database size={size}/> },
  { id: 'file', name: 'File', caption: 'PDF, image', group: 'Bring in', kind: 'topic', blockType: 'file', needs: 'A project folder', asks: true, line: 'A PDF or an image kept in the project folder. The text of a PDF is read so agents can use it.', facts: ['Saved into files/ in the project folder', 'A PDF’s text is read for agents'], icon: size => <FileIcon size={size}/> },
  { id: 'paper', name: 'Paper', caption: 'DOI, arXiv', group: 'Bring in', kind: 'topic', needs: 'Nothing', asks: true, line: 'A paper found on OpenAlex, arXiv or Zotero, with its reference and its open PDF when there is one.', facts: ['Searches OpenAlex, arXiv and Zotero', 'An open PDF becomes a File block'], icon: size => <GraduationCap size={size}/> },
  { id: 'notion', name: 'Notion', caption: 'Page, database', group: 'Bring in', kind: 'topic', blockType: 'notion', needs: 'Notion connected', asks: true, line: 'A Notion page or database shown live through your Notion connection. Rows can be filtered.', facts: ['Reads live, nothing is copied', 'Database rows can be filtered'], icon: size => <BrandLogo id="notion" size={size}/> },
  { id: 'google', name: 'Google Drive', caption: 'Sheet, Doc', group: 'Bring in', kind: 'topic', blockType: 'google', needs: 'Google signed in', asks: true, line: 'A Google Sheet or Doc read live through your Google sign-in, which only reads.', facts: ['Reads live, nothing is copied', 'The link picks the tab'], icon: size => <BrandLogo id="google-drive" size={size}/> },
  { id: 'map', name: 'Map', caption: 'Places', group: 'Build', kind: 'topic', blockType: 'map', needs: 'Nothing', line: 'Places pinned on an OpenStreetMap map, by you or by an agent. Each place opens in Google Maps.', facts: ['Agents pin places by name or address', 'Opens in Google Maps, no key needed'], icon: size => <MapPinned size={size}/> },
  { id: 'app', name: 'App', caption: 'Interactive', group: 'Build', kind: 'topic', blockType: 'app', needs: 'Apps on in Settings', line: 'A small page an agent builds for you, sealed on its card. It reads only the blocks you name as inputs.', facts: ['Reads only the inputs you name', 'An agent writes the page'], icon: size => <AppWindow size={size}/> },
  { id: 'training', name: 'Training run', caption: 'GPU', group: 'Build', kind: 'topic', blockType: 'training', needs: 'An ssh host', asks: true, localOnly: true, line: 'Follows a model training run: the data from a folder here, the loss curve from the GPU machine over your own ssh.', facts: ['Data from a folder on this computer', 'The loss curve over your own ssh'], icon: size => <BrandLogo id="nebius" size={size}/> },
  { id: 'group', name: 'Group', caption: 'Frame', group: 'Build', kind: 'group', needs: 'Nothing', line: 'A frame for blocks that belong together. Closes to one card; opens to show its blocks.', facts: ['Closes to one card', 'Agents can work inside it'], icon: size => <LayoutGrid size={size}/> },
];
export const KIND_GROUPS: KindGroup[] = ['Write', 'Bring in', 'Build'];
export const blockKind = (id: KindId) => BLOCK_KINDS.find(kind => kind.id === id)!;

/** The kinds this computer can add: a Training run needs the local workspace. */
export const availableKinds = (local: boolean) => BLOCK_KINDS.filter(kind => local || !kind.localOnly);

/** Name, caption, what it does and what it needs all count, so "pdf" finds File and Paper. */
export function searchKinds(query: string, local: boolean) {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (!words.length) return availableKinds(local);
  return availableKinds(local).filter(kind => { const text = `${kind.name} ${kind.caption} ${kind.line} ${kind.needs} ${kind.facts.join(' ')}`.toLowerCase(); return words.every(word => text.includes(word)); });
}

const USAGE_KEY = 'ros-ai:block-usage';
const FIRST_SIX: KindId[] = ['text', 'code', 'notebook', 'data', 'file', 'paper'];
/** The six kinds this person adds most, by their own counts in this browser; a new install starts with the first six. */
export function mostUsedKinds(local: boolean): BlockKind[] {
  const counts = readSaved<Partial<Record<KindId, number>>>(USAGE_KEY, {});
  const rank = (kind: BlockKind) => { const first = FIRST_SIX.indexOf(kind.id); return first === -1 ? FIRST_SIX.length + BLOCK_KINDS.indexOf(kind) : first; };
  return [...availableKinds(local)].sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0) || rank(a) - rank(b)).slice(0, 6);
}
export function noteKindUse(id: KindId) {
  const counts = readSaved<Partial<Record<KindId, number>>>(USAGE_KEY, {});
  saveLocal(USAGE_KEY, { ...counts, [id]: (counts[id] ?? 0) + 1 });
}
