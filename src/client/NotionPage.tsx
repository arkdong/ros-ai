import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUpRight, Check, LoaderCircle, Plus, X } from 'lucide-react';
import type { NotionFieldValue, NotionPage, NotionProperty, NotionSave, NotionUnit } from '../shared/types';
import { lineMarkdown, parseLine, type LineKind, type Mark, type Run } from '../shared/notion-inline';
import { api } from './api';
import { RichText } from './Content';

/** A Notion page edited the way Notion edits it: the title, every field, then the text block by block, each block
 * formatted in place (no Markdown marks). Enter starts a new block, Backspace at the start joins two, # - 1. [] "
 * and a space turn a line into a heading, list, to-do or quote, ⌘B ⌘I ⌘E format. Nothing reaches Notion until the
 * person presses Save to Notion (or ⌘S); then every change goes in one go and the page is read again. */

/** A block of text being edited. `origin` is Notion's text for the block it started as; new blocks have none. */
type Draft = { id: number; origin?: string; kind: LineKind; checked: boolean; indent: string; tail: string; html: string; rev: number };
/** A block that stays read only (a table, a toggle, media), shown as it was read. */
type Fixed = { id: number; unit: NotionUnit };
type Item = Draft | Fixed;
type Edits = { items: Item[]; title?: string; fields: Record<string, NotionFieldValue>; removed: string[] };

let ids = 1;
const isFixed = (item: Item): item is Fixed => 'unit' in item;
const LISTS: LineKind[] = ['bullet', 'number', 'todo'];
const PLACEHOLDER: Partial<Record<LineKind, string>> = { h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4', bullet: 'List', number: 'List', todo: 'To-do', quote: 'Quote' };
/** Unsaved edits of a page whose view was closed, so reopening it brings them back. */
const unsaved = new Map<string, Edits>();

const fromPage = (page: NotionPage): Item[] => page.units.map(unit => {
  if (!unit.source) return { id: ids++, unit };
  const line = parseLine(unit.source);
  return { id: ids++, origin: unit.source, kind: line.kind, checked: line.checked, indent: line.indent, tail: line.tail, html: runsHtml(line.runs, unit.labels), rev: 0 };
});
const blank = (kind: LineKind = 'p', indent = ''): Draft => ({ id: ids++, kind, checked: false, indent, tail: '', html: '', rev: 0 });

const escapeHtml = (text: string) => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
const safeHref = (url: string) => /^(https?:|mailto:)/iu.test(url) ? url : '#';
/** Runs as the HTML the editor shows: real bold, italics and links; a mention or date as one piece that keeps its tag. */
function runsHtml(runs: Run[], labels: Record<string, string> = {}): string {
  return runs.map(run => {
    let html = 'atom' in run
      ? `<span class="notion-atom" contenteditable="false" data-raw="${escapeHtml(run.atom)}">${escapeHtml(labels[run.atom] ?? run.atom.match(/>([^<]+)</u)?.[1] ?? '…')}</span>`
      : escapeHtml(run.text).replace(/\n/gu, '<br>');
    for (const mark of [...run.marks].reverse()) {
      if (mark === 'b' || mark === 'i' || mark === 's' || mark === 'code') html = `<${mark}>${html}</${mark}>`;
      else if (mark.startsWith('a:')) html = `<a href="${escapeHtml(safeHref(mark.slice(2)))}" data-href="${escapeHtml(mark.slice(2))}">${html}</a>`;
      else if (mark.startsWith('t:')) { const name = mark.split(':')[1], open = mark.slice(name.length + 3); html = `<span class="notion-tagged${/underline="true"/u.test(open) ? ' underline' : ''}" data-tag="${escapeHtml(name)}" data-open="${escapeHtml(open)}">${html}</span>`; }
    }
    return html;
  }).join('');
}

/** What the person wrote, back as runs: whatever the browser made of bold or italics counts as such. */
function domRuns(root: Node): Run[] {
  const out: Run[] = [];
  const walk = (node: Node, marks: Mark[]) => node.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) { const text = (child.textContent ?? '').replace(/ /gu, ' ').replace(/​/gu, ''); if (text) out.push({ text, marks }); return; }
    if (!(child instanceof HTMLElement)) return;
    if (child.dataset.raw) { out.push({ atom: child.dataset.raw, marks }); return; }
    const tag = child.tagName.toLowerCase(), style = child.style, next = [...marks];
    if (tag === 'br') { out.push({ text: '\n', marks }); return; }
    if (['b', 'strong'].includes(tag) || Number(style.fontWeight) >= 600 || style.fontWeight === 'bold') next.push('b');
    if (['i', 'em'].includes(tag) || style.fontStyle === 'italic') next.push('i');
    if (['s', 'strike', 'del'].includes(tag) || style.textDecoration.includes('line-through')) next.push('s');
    if (tag === 'code') next.push('code');
    if (tag === 'a' && (child.dataset.href || child.getAttribute('href'))) next.push(`a:${child.dataset.href || child.getAttribute('href')}`);
    if (child.dataset.open && child.dataset.tag) next.push(`t:${child.dataset.tag}:${child.dataset.open}`);
    if ((tag === 'div' || tag === 'p') && out.length) out.push({ text: '\n', marks });
    walk(child, [...new Set(next)]);
  });
  walk(root, []);
  while (out.length && 'text' in out[out.length - 1] && /^\n+$/u.test((out[out.length - 1] as { text: string }).text)) out.pop();
  return out;
}
const htmlRuns = (html: string) => { const box = document.createElement('div'); box.innerHTML = html; return domRuns(box); };

/** Where the caret is, in characters from the start of a block. */
function caretOffset(element: HTMLElement): number {
  const selection = getSelection();
  if (!selection?.rangeCount || !element.contains(selection.anchorNode)) return 0;
  const before = document.createRange(); before.selectNodeContents(element);
  const range = selection.getRangeAt(0); before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}
const atEnd = (element: HTMLElement) => {
  const selection = getSelection();
  if (!selection?.rangeCount) return false;
  const after = document.createRange(); after.selectNodeContents(element);
  const range = selection.getRangeAt(0); after.setStart(range.endContainer, range.endOffset);
  return after.toString() === '';
};
function placeCaret(element: HTMLElement, at: number | 'end') {
  element.focus();
  const selection = getSelection(), range = document.createRange();
  if (!selection) return;
  range.selectNodeContents(element); range.collapse(at !== 0 && at === 'end' ? false : true);
  if (typeof at === 'number' && at > 0) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let left = at, node: Node | null, placed = false;
    while ((node = walker.nextNode())) { const length = node.textContent?.length ?? 0; if (length >= left) { range.setStart(node, left); range.collapse(true); placed = true; break; } left -= length; }
    if (!placed) { range.selectNodeContents(element); range.collapse(false); }
  }
  selection.removeAllRanges(); selection.addRange(range);
}
/** Whether the caret sits on a block's first (or last) line, so the arrow keys move to the block above (or below). */
function onEdgeLine(element: HTMLElement, edge: 'first' | 'last') {
  const selection = getSelection();
  if (!selection?.rangeCount) return true;
  const rect = selection.getRangeAt(0).getClientRects()[0];
  if (!rect) return edge === 'first' ? caretOffset(element) === 0 : atEnd(element);
  const box = element.getBoundingClientRect(), line = parseFloat(getComputedStyle(element).lineHeight) || 22;
  return edge === 'first' ? rect.top - box.top < line * 0.8 : box.bottom - rect.bottom < line * 0.8;
}

/** Typing **bold**, *italic*, `code` or ~~strike~~ formats the words as soon as the closing mark is typed, as in Notion. */
function autoformat(element: HTMLElement) {
  const selection = getSelection();
  if (!selection?.isCollapsed || !selection.anchorNode || selection.anchorNode.nodeType !== Node.TEXT_NODE || !element.contains(selection.anchorNode)) return;
  const node = selection.anchorNode as Text, before = node.data.slice(0, selection.anchorOffset);
  const found = before.match(/(\*\*|~~|`|\*)([^*`~\n]*[^*`~\s])\1$/u);
  if (!found || (found[1] === '*' && before[before.length - found[0].length - 1] === '*') || /^\s/u.test(found[2])) return;
  const tag = found[1] === '**' ? 'b' : found[1] === '*' ? 'i' : found[1] === '`' ? 'code' : 's';
  const start = selection.anchorOffset - found[0].length, range = document.createRange();
  range.setStart(node, start); range.setEnd(node, selection.anchorOffset);
  range.deleteContents();
  const formatted = document.createElement(tag); formatted.textContent = found[2];
  // A zero-width space after the words keeps what comes next unformatted; it is dropped on save.
  const after = document.createTextNode('\u200b');
  range.insertNode(after); range.insertNode(formatted);
  const caret = document.createRange(); caret.setStart(after, 1); caret.collapse(true);
  selection.removeAllRanges(); selection.addRange(caret);
}

/** A page's text as Notion shows it, for the card on the canvas: each block formatted, without Markdown marks. */
export function NotionText({ page }: { page: NotionPage }) {
  let number = 0;
  return <div className="notion-text">{page.units.map((unit, index) => {
    if (!unit.source) { number = 0; return <div key={index} className="notion-line fixed"><RichText text={unit.markdown}/></div>; }
    const line = parseLine(unit.source);
    number = line.kind === 'number' ? number + 1 : 0;
    return <div key={index} className={`notion-line ${line.kind}${line.checked ? ' checked' : ''}`}>
      {line.kind === 'bullet' && <span className="notion-line-mark" aria-hidden="true">•</span>}
      {line.kind === 'number' && <span className="notion-line-mark number" aria-hidden="true">{number}.</span>}
      {line.kind === 'todo' && <span className="notion-line-mark" aria-hidden="true">{line.checked ? '☑' : '☐'}</span>}
      <div className="notion-line-text">{line.runs.map((run, at) => <RunView key={at} run={run} labels={unit.labels}/>)}</div>
    </div>;
  })}</div>;
}
function RunView({ run, labels = {} }: { run: Run; labels?: Record<string, string> }) {
  let node: ReactNode = 'atom' in run ? <span className="notion-atom">{labels[run.atom] ?? run.atom.match(/>([^<]+)</u)?.[1] ?? '…'}</span> : run.text;
  for (const mark of [...run.marks].reverse()) {
    if (mark === 'b') node = <b>{node}</b>; else if (mark === 'i') node = <i>{node}</i>; else if (mark === 's') node = <s>{node}</s>; else if (mark === 'code') node = <code>{node}</code>;
    else if (mark.startsWith('a:')) node = <a href={safeHref(mark.slice(2))} target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()}>{node}</a>;
    else if (mark.startsWith('t:') && /underline="true"/u.test(mark)) node = <span className="underline">{node}</span>;
  }
  return <>{node}</>;
}

/** A field's value as it was read, in the form a change takes. */
function readValue(property: NotionProperty): NotionFieldValue {
  if (property.type === 'multi_select') return { value: property.values ?? (property.value ? property.value.split(', ') : []) };
  if (property.type === 'checkbox') return { value: property.value === 'Yes' };
  if (property.type === 'date') return { value: property.date?.start || null, end: property.date?.end || null };
  return { value: property.value || null };
}
const sameValue = (a: NotionFieldValue, b: NotionFieldValue) => JSON.stringify([a.value === '' ? null : a.value, a.end ?? null]) === JSON.stringify([b.value === '' ? null : b.value, b.end ?? null]);
/** A field as it shows with an unsaved change in it. */
function withValue(property: NotionProperty, change?: NotionFieldValue): NotionProperty {
  if (!change) return property;
  const value = change.value;
  if (property.type === 'multi_select') { const values = Array.isArray(value) ? value : []; return { ...property, values, value: values.join(', ') }; }
  if (property.type === 'checkbox') return { ...property, value: value ? 'Yes' : 'No' };
  if (property.type === 'date') return { ...property, date: { start: String(value ?? ''), end: String(change.end ?? '') } };
  return { ...property, value: value === null ? '' : String(value) };
}

export function NotionPageEditor({ page, projectId, nodeId, readOnly, onSaved, onTitle }: { page: NotionPage; projectId: string; nodeId: string; readOnly?: boolean; onSaved: (page: NotionPage) => void; onTitle?: (title: string) => void }) {
  const [edits, setEdits] = useState<Edits>(() => {
    const kept = unsaved.get(nodeId);
    // Unsaved edits come back only while every block they change is still on the page.
    if (kept && kept.items.every(item => isFixed(item) || !item.origin || page.units.some(unit => unit.source === item.origin))) return kept;
    unsaved.delete(nodeId);
    return { items: fromPage(page), fields: {} , removed: [] };
  });
  const [count, setCount] = useState(0), [status, setStatus] = useState<{ busy?: boolean; saved?: boolean; error?: string }>({});
  const elements = useRef(new Map<number, HTMLDivElement>()), live = useRef(new Map<number, string>());
  const focus = useRef<{ id: number; at: number | 'end' } | null>(null), saved = useRef(false), latest = useRef(edits), read = useRef(page.fetchedAt);
  latest.current = edits;
  const { items } = edits;

  const runsOf = (draft: Draft) => { const element = elements.current.get(draft.id); return element?.isConnected ? domRuns(element) : htmlRuns(live.current.get(draft.id) ?? draft.html); };
  const lineOf = (draft: Draft) => lineMarkdown({ kind: draft.kind, checked: draft.checked, indent: draft.indent, tail: draft.tail, runs: runsOf(draft) });

  /** Everything that differs from what Notion holds, as one save. A new block joins the replacement of the block
   * above it (or below it, at the top of a run of text), so it lands where it was written. */
  function pending(state: Edits = latest.current) {
    const text: { old: string; new: string }[] = state.removed.map(old => ({ old, new: '' })), dirty = new Set<number>(), append: string[] = [];
    const groups: { origin: string; lines: string[] }[] = [];
    let current: { origin: string; lines: string[] } | null = null, waiting: string[] = [];
    for (const item of state.items) {
      if (isFixed(item)) { append.push(...waiting); waiting = []; current = null; continue; }
      const line = lineOf(item);
      if (item.origin !== undefined) {
        if (line !== lineMarkdown(parseLine(item.origin))) dirty.add(item.id);
        groups.push(current = { origin: item.origin, lines: [...waiting, line] }); waiting = [];
      } else {
        if (line) dirty.add(item.id);
        if (current) current.lines.push(line); else waiting.push(line);
      }
    }
    append.push(...waiting);
    for (const group of groups) { const next = group.lines.filter(Boolean).join('\n'); if (next !== lineMarkdown(parseLine(group.origin))) text.push({ old: group.origin, new: next }); }
    const fields = Object.entries(state.fields).map(([name, change]) => ({ name, ...change }));
    const save: NotionSave = { ...(state.title !== undefined ? { title: state.title } : {}), ...(fields.length ? { properties: fields } : {}), ...(text.length ? { text } : {}), ...(append.some(Boolean) ? { append: append.filter(Boolean).join('\n') } : {}) };
    return { save, dirty, count: text.length + (save.append ? 1 : 0) + fields.length + (state.title !== undefined ? 1 : 0) };
  }
  const recount = () => {
    const { dirty, count: next } = pending();
    elements.current.forEach((element, id) => element.parentElement?.classList.toggle('dirty', dirty.has(id)));
    setCount(next);
    if (next) setStatus(state => state.saved ? {} : state);
  };

  // A new read from Notion: after a save, or when nothing is unsaved, the page shows what Notion holds now.
  useEffect(() => {
    if (read.current === page.fetchedAt) return;
    read.current = page.fetchedAt;
    if (!saved.current && pending().count) return;
    const wasSaved = saved.current; saved.current = false;
    live.current.clear(); unsaved.delete(nodeId);
    setEdits({ items: fromPage(page), fields: {}, removed: [] });
    setStatus(wasSaved ? { saved: true } : {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.fetchedAt]);
  useEffect(() => { if (!status.saved) return; const timer = setTimeout(() => setStatus({}), 2500); return () => clearTimeout(timer); }, [status.saved]);
  useLayoutEffect(() => {
    const target = focus.current && elements.current.get(focus.current.id);
    if (target && focus.current) placeCaret(target, focus.current.at);
    focus.current = null;
    recount();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits]);
  // Closing the view keeps unsaved edits for when it opens again.
  useEffect(() => () => {
    if (!pending().count) { unsaved.delete(nodeId); return; }
    unsaved.set(nodeId, { ...latest.current, items: latest.current.items.map(item => isFixed(item) ? item : { ...item, html: live.current.get(item.id) ?? item.html, rev: item.rev + 1 }) });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    const { save: changes, count: changed } = pending();
    if (!changed || status.busy || readOnly) return;
    setStatus({ busy: true });
    try {
      const next = await api<NotionPage>(`/api/projects/${projectId}/nodes/${nodeId}/notion/save`, { method: 'POST', body: JSON.stringify(changes), signal: AbortSignal.timeout(120_000) });
      saved.current = true;
      onSaved(next);
      if (changes.title !== undefined) onTitle?.(next.title);
    } catch (reason) { setStatus({ error: reason instanceof Error ? reason.message : String(reason) }); }
  };
  const discard = () => { live.current.clear(); unsaved.delete(nodeId); setStatus({}); setEdits({ items: fromPage(page), fields: {}, removed: [] }); };

  const update = (change: (state: Edits) => Edits) => setEdits(state => change(state));
  const at = (id: number) => items.findIndex(item => item.id === id);
  const neighbour = (id: number, step: 1 | -1): Draft | undefined => { for (let index = at(id) + step; index >= 0 && index < items.length; index += step) { const item = items[index]; if (!isFixed(item)) return item; } return undefined; };
  const remember = (id: number) => { const element = elements.current.get(id); if (element) live.current.set(id, element.innerHTML); };
  const replace = (id: number, patch: Partial<Draft>, insert: { before?: Draft[]; after?: Draft[] } = {}) => update(state => ({ ...state, items: state.items.flatMap(item => item.id !== id ? [item] : [...(insert.before ?? []), { ...(item as Draft), ...patch }, ...(insert.after ?? [])]) }));

  /** Enter: the words after the caret move to a new block below; lists carry on, an empty list item ends the list. */
  function split(draft: Draft, element: HTMLElement) {
    const selection = getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!range.collapsed) range.deleteContents();
    const empty = !element.textContent?.trim() && !element.querySelector('[data-raw]');
    if (empty && (LISTS.includes(draft.kind) || draft.kind === 'quote')) { replace(draft.id, { kind: 'p' }); focus.current = { id: draft.id, at: 0 }; return; }
    if (!empty && caretOffset(element) === 0) { const above = blank('p', draft.indent); focus.current = { id: draft.id, at: 0 }; replace(draft.id, {}, { before: [above] }); return; }
    const tail = document.createRange(); tail.selectNodeContents(element); tail.setStart(range.endContainer, range.endOffset);
    const box = document.createElement('div'); box.append(tail.extractContents());
    const html = box.textContent || box.querySelector('[data-raw]') ? box.innerHTML : '';
    remember(draft.id);
    const below = { ...blank(LISTS.includes(draft.kind) ? draft.kind : 'p', draft.indent), html };
    focus.current = { id: below.id, at: 0 };
    replace(draft.id, { html: element.innerHTML }, { after: [below] });
  }
  /** Backspace at the start of a block joins it to the block above; the caret stays where they meet. */
  function join(upper: Draft, lower: Draft) {
    const top = elements.current.get(upper.id), bottom = elements.current.get(lower.id);
    if (!top || !bottom) return;
    top.querySelectorAll(':scope > br:last-child').forEach(node => node.remove());
    const offset = top.textContent?.length ?? 0, html = top.innerHTML + bottom.innerHTML;
    live.current.set(upper.id, html); live.current.delete(lower.id);
    focus.current = { id: upper.id, at: offset };
    update(state => ({ ...state, removed: lower.origin !== undefined ? [...state.removed, lower.origin] : state.removed, items: state.items.flatMap(item => item.id === lower.id ? [] : item.id === upper.id ? [{ ...(item as Draft), html, rev: (item as Draft).rev + 1 }] : [item]) }));
  }

  function keys(draft: Draft, event: KeyboardEvent<HTMLDivElement>) {
    const element = event.currentTarget, mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey) {
      const key = event.key.toLowerCase();
      // Underline has no Markdown of its own, so the browser's ⌘U is held back rather than lost on save.
      if (key === 'u') { event.preventDefault(); return; }
      const command = key === 'b' ? 'bold' : key === 'i' ? 'italic' : event.shiftKey && key === 's' ? 'strikeThrough' : null;
      if (command) { event.preventDefault(); document.execCommand(command); recountSoon(draft.id); return; }
      if (key === 'e') {
        event.preventDefault();
        const selection = getSelection();
        if (selection?.rangeCount && !selection.isCollapsed) { document.execCommand('insertHTML', false, `<code>${escapeHtml(selection.toString())}</code>`); recountSoon(draft.id); }
        return;
      }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); split(draft, element); return; }
    if (event.key === 'Backspace' && getSelection()?.isCollapsed && caretOffset(element) === 0) {
      // Notion first turns a heading, list item or quote back into text, then joins it to the block above.
      if (draft.kind !== 'p') { event.preventDefault(); replace(draft.id, { kind: 'p' }); focus.current = { id: draft.id, at: 0 }; return; }
      const index = at(draft.id), above = items[index - 1];
      if (above && !isFixed(above)) { event.preventDefault(); join(above, draft); }
      return;
    }
    if (event.key === 'Delete' && getSelection()?.isCollapsed && atEnd(element)) {
      const below = items[at(draft.id) + 1];
      if (below && !isFixed(below)) { event.preventDefault(); join(draft, below); }
      return;
    }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey) {
      const up = event.key === 'ArrowUp', next = neighbour(draft.id, up ? -1 : 1);
      if (next && onEdgeLine(element, up ? 'first' : 'last')) { event.preventDefault(); const target = elements.current.get(next.id); if (target) placeCaret(target, up ? 'end' : 0); }
    }
  }
  const recountSoon = (id: number) => requestAnimationFrame(() => { remember(id); recount(); });

  /** Typing # - 1. [] or " then a space at the start of a line turns it into that kind of block, as in Notion. */
  function typed(draft: Draft, element: HTMLDivElement) {
    autoformat(element);
    remember(draft.id);
    element.toggleAttribute('data-empty', !element.textContent && !element.querySelector('[data-raw]'));
    if (draft.kind === 'p') {
      const shortcut = (element.textContent ?? '').match(/^(#{1,3}|[-*+]|1\.|\[ ?\]|")[  ]/u);
      if (shortcut && caretOffset(element) === shortcut[0].length) {
        const mark = shortcut[1], kind: LineKind = mark.startsWith('#') ? (['h1', 'h2', 'h3'] as const)[mark.length - 1] : mark === '1.' ? 'number' : mark.startsWith('[') ? 'todo' : mark === '"' ? 'quote' : 'bullet';
        const range = document.createRange(), walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let left = shortcut[0].length, node: Node | null;
        range.setStart(element, 0);
        while ((node = walker.nextNode())) { const length = node.textContent?.length ?? 0; if (length >= left) { range.setEnd(node, left); break; } left -= length; }
        range.deleteContents();
        remember(draft.id);
        element.toggleAttribute('data-empty', !element.textContent);
        focus.current = { id: draft.id, at: 0 };
        replace(draft.id, { kind, html: element.innerHTML });
        return;
      }
    }
    recount();
  }
  /** Pasted text comes in as plain words; each further line becomes a block of its own. */
  function pasted(draft: Draft, event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const lines = event.clipboardData.getData('text/plain').replace(/\r\n?/gu, '\n').split('\n');
    document.execCommand('insertText', false, lines[0]);
    if (lines.length === 1) { recountSoon(draft.id); return; }
    const element = event.currentTarget, selection = getSelection();
    if (!selection?.rangeCount) return;
    const tail = document.createRange(); tail.selectNodeContents(element); tail.setStart(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
    const box = document.createElement('div'); box.append(tail.extractContents());
    remember(draft.id);
    const rest = lines.slice(1).map((line, index, all) => ({ ...blank('p', draft.indent), html: escapeHtml(line) + (index === all.length - 1 ? box.innerHTML : '') }));
    focus.current = { id: rest[rest.length - 1].id, at: lines[lines.length - 1].length };
    replace(draft.id, { html: element.innerHTML }, { after: rest });
  }
  const add = (draft: Draft) => { const below = blank('p', draft.indent); focus.current = { id: below.id, at: 0 }; remember(draft.id); replace(draft.id, {}, { after: [below] }); };
  const addAtEnd = () => { const last = items[items.length - 1]; if (last && !isFixed(last) && !elements.current.get(last.id)?.textContent) { const element = elements.current.get(last.id); if (element) placeCaret(element, 'end'); return; } const below = blank(); focus.current = { id: below.id, at: 0 }; update(state => ({ ...state, items: [...state.items, below] })); };

  const fields = page.properties.filter(property => property.type !== 'title');
  const setField = (property: NotionProperty, change: NotionFieldValue) => update(state => {
    const next = { ...state.fields };
    if (sameValue(change, readValue(property))) delete next[property.name]; else next[property.name] = change;
    return { ...state, fields: next };
  });
  let number = 0;
  return <div className="notion-page" onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); } }}>
    <div className="notion-page-title-row">
      {page.icon && <span className="notion-page-icon" aria-hidden="true">{page.icon}</span>}
      <input className={`notion-page-title${edits.title !== undefined ? ' dirty' : ''}`} aria-label="Page title" value={edits.title ?? page.title} placeholder="Untitled" readOnly={readOnly} maxLength={2000}
        onChange={event => { const value = event.target.value; update(state => ({ ...state, title: value === page.title ? undefined : value })); }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); const first = items.find(item => !isFixed(item)); const element = first && elements.current.get(first.id); if (element) placeCaret(element, 0); } }}/>
    </div>
    {fields.length > 0 && <dl className="notion-page-fields">{fields.map(property => <PropertyRow key={property.name} property={withValue(property, edits.fields[property.name])} changed={property.name in edits.fields} readOnly={readOnly} onChange={change => setField(property, change)}/>)}</dl>}
    <div className="notion-page-text">
      {items.map(item => {
        if (isFixed(item)) { number = 0; return <div key={item.id} className="notion-line fixed" title="Edit this kind of block in Notion"><RichText text={item.unit.markdown}/></div>; }
        number = item.kind === 'number' ? number + 1 : 0;
        return <Line key={item.id} draft={item} number={item.kind === 'number' ? number : undefined} readOnly={readOnly}
          register={(element) => { if (element) elements.current.set(item.id, element); else elements.current.delete(item.id); }}
          onKeyDown={event => keys(item, event)} onInput={element => typed(item, element)} onPaste={event => pasted(item, event)}
          onCheck={() => replace(item.id, { checked: !item.checked })} onAdd={() => add(item)}/>;
      })}
      {!items.length && readOnly && <p className="notion-page-empty">An empty page.</p>}
      {!readOnly && <div className="notion-page-tail" onClick={addAtEnd} aria-hidden="true"/>}
    </div>
    {!readOnly && (count > 0 || status.busy || status.error || status.saved) && <div className="notion-save-bar" role="status">
      {status.saved && !count ? <span className="notion-save-done"><Check size={13}/> Saved in Notion</span> : <>
        <span className={`notion-save-count${status.error ? ' error' : ''}`} title={status.error}>{status.error ? status.error : <><i aria-hidden="true"/>{count} unsaved change{count === 1 ? '' : 's'}</>}</span>
        <button type="button" className="small secondary" disabled={status.busy} onClick={discard}>Discard</button>
        <button type="button" className="small primary" disabled={status.busy || !count} onClick={() => void save()} title="Save to Notion (⌘S)">{status.busy ? <><LoaderCircle size={12} className="spin"/> Saving…</> : 'Save to Notion'}</button>
      </>}
    </div>}
  </div>;
}

/** One block of text, edited in place; the browser keeps its words, React only its kind. */
function Line({ draft, number, readOnly, register, onKeyDown, onInput, onPaste, onCheck, onAdd }: { draft: Draft; number?: number; readOnly?: boolean; register: (element: HTMLDivElement | null) => void; onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void; onInput: (element: HTMLDivElement) => void; onPaste: (event: ClipboardEvent<HTMLDivElement>) => void; onCheck: () => void; onAdd: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const element = ref.current; if (!element) return; element.innerHTML = draft.html; element.toggleAttribute('data-empty', !element.textContent && !element.querySelector('[data-raw]')); }, [draft.rev]);
  useLayoutEffect(() => { register(ref.current); return () => register(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className={`notion-line ${draft.kind}${draft.checked ? ' checked' : ''}`} style={draft.indent ? { marginLeft: `${Math.min(draft.indent.replace(/ {4}/gu, '\t').length, 6) * 24}px` } : undefined}>
    {!readOnly && <button type="button" className="notion-line-add" tabIndex={-1} aria-label="Add a block below" title="Add a block below" onMouseDown={event => event.preventDefault()} onClick={onAdd}><Plus size={14}/></button>}
    {draft.kind === 'bullet' && <span className="notion-line-mark" aria-hidden="true">•</span>}
    {number !== undefined && <span className="notion-line-mark number" aria-hidden="true">{number}.</span>}
    {draft.kind === 'todo' && <input type="checkbox" className="notion-line-check" aria-label="Done" checked={draft.checked} disabled={readOnly} onChange={onCheck}/>}
    <div ref={ref} className="notion-line-text" contentEditable={!readOnly} suppressContentEditableWarning role="textbox" aria-label="Text" spellCheck
      data-placeholder={PLACEHOLDER[draft.kind] ?? 'Write something, or type # - [] for a heading, list or to-do'}
      onKeyDown={onKeyDown} onInput={event => onInput(event.currentTarget)} onPaste={onPaste}
      onClick={event => { const link = (event.target as HTMLElement).closest('a'); if (link && (event.metaKey || event.ctrlKey || readOnly)) { event.preventDefault(); window.open(link.getAttribute('href') ?? '#', '_blank', 'noreferrer'); } }}/>
  </div>;
}

const typeMark: Record<NotionProperty['type'], string> = { title: 'Aa', text: '≡', select: '◦', multi_select: '⁝', checkbox: '☑', date: '▦', number: '#', people: '◉', relation: '↗', files: '⎘', computed: 'ƒ' };

function PropertyRow({ property, changed, readOnly, onChange }: { property: NotionProperty; changed: boolean; readOnly?: boolean; onChange: (change: NotionFieldValue) => void }) {
  const editable = property.editable && !readOnly;
  return <div className={`notion-page-field${editable ? '' : ' fixed'}${changed ? ' dirty' : ''}`}>
    <dt title={property.name}><i aria-hidden="true">{typeMark[property.type]}</i>{property.name}</dt>
    <dd title={editable ? undefined : 'Set in Notion'}>
      {!editable ? <Shown property={property}/>
        : property.type === 'select' ? <select className="notion-page-select" aria-label={property.name} value={property.value} onChange={event => onChange({ value: event.target.value || null })}>
            <option value="">Empty</option>{[...new Set([...(property.options ?? []), ...(property.value ? [property.value] : [])])].map(option => <option key={option} value={option}>{option}</option>)}</select>
        : property.type === 'multi_select' ? <Chips property={property} onChange={values => onChange({ value: values })}/>
        : property.type === 'checkbox' ? <input type="checkbox" aria-label={property.name} checked={property.value === 'Yes'} onChange={event => onChange({ value: event.target.checked })}/>
        : property.type === 'date' ? <DateField property={property} onChange={(start, end) => onChange({ value: start, end })}/>
        : <TextField value={property.value} kind={property.type === 'number' ? 'number' : undefined} label={property.name} onChange={value => onChange({ value: value === '' ? null : value })}/>}
    </dd>
  </div>;
}

/** A value that is only shown: people, relations, files and what Notion computes. */
function Shown({ property }: { property: NotionProperty }) {
  if (property.links?.length) return <>{property.links.map((link, index) => <a key={index} href={link.url} target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()}>{link.text}<ArrowUpRight size={10}/></a>)}</>;
  if (property.type === 'multi_select' && property.values?.length) return <>{property.values.map(value => <span key={value} className="notion-chip">{value}</span>)}</>;
  if (!property.value) return <span className="notion-page-blank">Empty</span>;
  return <span className="notion-page-value">{property.value}</span>;
}

function TextField({ value, kind, label, onChange }: { value: string; kind?: 'number'; label: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const element = ref.current; if (element) { element.style.height = '0'; element.style.height = `${element.scrollHeight}px`; } }, [value]);
  const keys = (event: KeyboardEvent<HTMLElement>) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); } };
  if (kind === 'number') return <input className="notion-page-input" type="number" step="any" aria-label={label} value={value} placeholder="Empty" onChange={event => onChange(event.target.value)} onKeyDown={keys}/>;
  return <textarea ref={ref} className="notion-page-input" rows={1} aria-label={label} value={value} placeholder="Empty" onChange={event => onChange(event.target.value)} onKeyDown={keys}/>;
}

function Chips({ property, onChange }: { property: NotionProperty; onChange: (values: string[]) => void }) {
  const chosen = property.values ?? (property.value ? property.value.split(', ') : []);
  const rest = (property.options ?? []).filter(option => !chosen.includes(option));
  return <>
    {chosen.map(value => <span key={value} className="notion-chip">{value}<button type="button" aria-label={`Remove ${value}`} onClick={() => onChange(chosen.filter(item => item !== value))}><X size={10}/></button></span>)}
    {rest.length > 0 && <select className="notion-page-select add" aria-label={`Add to ${property.name}`} value="" onChange={event => { if (event.target.value) onChange([...chosen, event.target.value]); }}><option value="">+</option>{rest.map(option => <option key={option} value={option}>{option}</option>)}</select>}
  </>;
}

function DateField({ property, onChange }: { property: NotionProperty; onChange: (start: string | null, end: string | null) => void }) {
  const start = property.date?.start ?? '', end = property.date?.end ?? '';
  const [withEnd, setWithEnd] = useState(Boolean(end));
  useEffect(() => { if (end) setWithEnd(true); }, [end]);
  return <>
    <input className="notion-page-input date" type="date" aria-label={property.name} value={start} onChange={event => onChange(event.target.value || null, event.target.value ? end || null : null)}/>
    {withEnd ? <><span className="notion-page-blank">to</span><input className="notion-page-input date" type="date" aria-label={`${property.name} end`} value={end} onChange={event => onChange(start || null, event.target.value || null)}/></>
      : start ? <button type="button" className="text-button small notion-page-end" onClick={() => setWithEnd(true)}>+ end</button> : null}
  </>;
}
