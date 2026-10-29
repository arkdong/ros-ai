import { useEffect, useRef, useState } from 'react';
import { Annotation, EditorState, Facet, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, placeholder as placeholderText, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, ensureSyntaxTree, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import './markdown-editor.css';

/** Text the parent passed in, so it is not echoed back through onChange. */
const external = Annotation.define<boolean>();

/** The smallest single change turning `current` into `next`, so the caret maps through it. */
function difference(current: string, next: string) {
  let from = 0;
  const limit = Math.min(current.length, next.length);
  while (from < limit && current.charCodeAt(from) === next.charCodeAt(from)) from++;
  let end = 0;
  while (end < limit - from && current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end++;
  return { from, to: current.length - end, insert: next.slice(from, next.length - end) };
}

const style = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.6em', fontWeight: '650' },
  { tag: tags.heading2, fontSize: '1.35em', fontWeight: '650' },
  { tag: tags.heading3, fontSize: '1.15em', fontWeight: '650' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '650' },
  { tag: tags.strong, fontWeight: '650' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: '#2f5f8a' },
  { tag: tags.url, color: '#2f5f8a' },
  { tag: tags.monospace, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '0.9em' },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName], color: '#a3a3a3' },
  { tag: tags.quote, color: '#555' },
]);

class Bullet extends WidgetType {
  eq() { return true; }
  toDOM() { const span = document.createElement('span'); span.className = 'cm-md-bullet'; span.textContent = '•'; return span; }
}
class Checkbox extends WidgetType {
  constructor(readonly checked: boolean, readonly at: number) { super(); }
  eq(other: Checkbox) { return other.checked === this.checked && other.at === this.at; }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox'; box.className = 'cm-md-task'; box.checked = this.checked; box.setAttribute('aria-label', this.checked ? 'Mark as not done' : 'Mark as done');
    box.addEventListener('mousedown', event => {
      event.preventDefault();
      if (view.state.readOnly) return;
      view.dispatch({ changes: { from: this.at + 1, to: this.at + 2, insert: this.checked ? ' ' : 'x' } });
    });
    return box;
  }
  ignoreEvent() { return true; }
}
class Rule extends WidgetType {
  eq() { return true; }
  toDOM() { const rule = document.createElement('span'); rule.className = 'cm-md-rule'; return rule; }
}

const hide = Decoration.replace({});
const lineClass = (name: string) => Decoration.line({ class: name });

/** Lines the caret or a selection touches. Their Markdown marks stay visible so they can be edited, as in Obsidian. */
function activeLines(view: EditorView) {
  const lines = new Set<number>();
  if (!view.hasFocus) return lines;
  for (const range of view.state.selection.ranges) {
    const first = view.state.doc.lineAt(range.from).number, last = view.state.doc.lineAt(range.to).number;
    for (let line = first; line <= last; line++) lines.add(line);
  }
  return lines;
}

/** Live preview: render headings, emphasis, links, lists, tasks, quotes and rules (tables are the `tables` field) in place and hide their marks away from the caret. */
function livePreview(view: EditorView): DecorationSet {
  const { state } = view, found: Range<Decoration>[] = [], active = activeLines(view);
  const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number);
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({ from, to, enter: node => {
      const name = node.name;
      const heading = /^ATXHeading(\d)$/.exec(name);
      if (heading) { found.push(lineClass(`cm-md-h${heading[1]}`).range(state.doc.lineAt(node.from).from)); return; }
      if (name === 'Blockquote') {
        for (let line = state.doc.lineAt(node.from).number, last = state.doc.lineAt(node.to).number; line <= last; line++) found.push(lineClass('cm-md-quote').range(state.doc.line(line).from));
        return;
      }
      if (name === 'FencedCode' || name === 'CodeBlock') {
        for (let line = state.doc.lineAt(node.from).number, last = state.doc.lineAt(node.to).number; line <= last; line++) found.push(lineClass('cm-md-codeblock').range(state.doc.line(line).from));
        return false;
      }
      if (name === 'HorizontalRule') {
        if (!isActive(node.from)) found.push(Decoration.replace({ widget: new Rule() }).range(node.from, node.to));
        return;
      }
      if (isActive(node.from)) return;
      if (name === 'HeaderMark') {
        // Hide "## " including the space after it.
        const end = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
        found.push(hide.range(node.from, end));
      } else if (name === 'EmphasisMark' || name === 'StrikethroughMark' || name === 'QuoteMark') {
        const end = name === 'QuoteMark' && state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
        found.push(hide.range(node.from, end));
      } else if (name === 'CodeMark' && node.node.parent?.name === 'InlineCode') {
        found.push(hide.range(node.from, node.to));
      } else if (name === 'Link') {
        // [text](url): keep the text, hide the brackets and the address.
        const marks = node.node.getChildren('LinkMark'), url = node.node.getChild('URL');
        if (marks.length >= 2) {
          found.push(hide.range(marks[0].from, marks[0].to));
          found.push(hide.range(marks[1].from, (marks.at(-1)!).to));
          found.push(Decoration.mark({ class: 'cm-md-link', attributes: url ? { title: state.sliceDoc(url.from, url.to) } : {} }).range(marks[0].to, marks[1].from));
        }
        return false;
      } else if (name === 'ListMark') {
        const item = node.node.parent, task = item?.getChild('Task');
        const end = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
        if (task) found.push(hide.range(node.from, end));
        else if (item?.parent?.name === 'BulletList') found.push(Decoration.replace({ widget: new Bullet() }).range(node.from, node.to));
      } else if (name === 'TaskMarker') {
        const checked = /x/i.test(state.sliceDoc(node.from, node.to));
        found.push(Decoration.replace({ widget: new Checkbox(checked, node.from) }).range(node.from, node.to));
        if (checked) { const line = state.doc.lineAt(node.to), start = node.to + (/^\s*/.exec(state.sliceDoc(node.to, line.to))?.[0].length ?? 0); if (line.to > start) found.push(Decoration.mark({ class: 'cm-md-done' }).range(start, line.to)); }
      }
    } });
  }
  return Decoration.set(found, true);
}

class Formula extends WidgetType {
  constructor(readonly tex: string, readonly block: boolean) { super(); }
  eq(other: Formula) { return other.tex === this.tex && other.block === this.block; }
  toDOM() {
    const holder = document.createElement(this.block ? 'div' : 'span');
    holder.className = this.block ? 'cm-md-math cm-md-math-block' : 'cm-md-math';
    katex.render(this.tex, holder, { displayMode: this.block, throwOnError: false });
    return holder;
  }
  // Let a click through, so it places the caret in the formula and shows its source.
  ignoreEvent() { return false; }
}

const focused = StateEffect.define<boolean>();
const focus = StateField.define<boolean>({ create: () => false, update: (value, tr) => tr.effects.reduce((current, effect) => effect.is(focused) ? effect.value : current, value) });
const inCode = (state: EditorState, pos: number) => {
  for (let node: SyntaxNode | null = (ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state)).resolveInner(pos, 1); node; node = node.parent) if (['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText'].includes(node.name)) return true;
  return false;
};

/** LaTeX as in Obsidian: $inline$ and $$block$$, rendered unless the caret is inside. A field, because a block can span lines. */
function formulas(state: EditorState): DecorationSet {
  const text = state.doc.toString(), found: Range<Decoration>[] = [], taken: [number, number][] = [];
  const editing = (from: number, to: number) => state.field(focus) && state.selection.ranges.some(range => range.from <= to && range.to >= from);
  for (const match of text.matchAll(/\$\$([\s\S]+?)\$\$/g)) {
    const from = match.index!, to = from + match[0].length;
    if (inCode(state, from)) continue;
    taken.push([from, to]);
    if (!editing(from, to)) found.push(Decoration.replace({ widget: new Formula(match[1].trim(), true), block: state.doc.lineAt(from).from === from && state.doc.lineAt(to).to === to }).range(from, to));
  }
  for (const match of text.matchAll(/(?<![\\$])\$(?![\s$])([^$\n]+?)(?<!\s)\$(?![$\d])/g)) {
    const from = match.index!, to = from + match[0].length;
    if (taken.some(([start, end]) => from < end && to > start) || inCode(state, from)) continue;
    if (!editing(from, to)) found.push(Decoration.replace({ widget: new Formula(match[1], false) }).range(from, to));
  }
  return Decoration.set(found, true);
}
const math = StateField.define<DecorationSet>({
  create: formulas,
  update: (value, tr) => tr.docChanged || tr.selection || tr.effects.some(effect => effect.is(focused)) || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? formulas(tr.state) : value,
  provide: field => EditorView.decorations.from(field),
});

/** Where an embedded image's bytes come from. Web and data addresses load as written; other paths go to the project folder, when the editor has one. */
const imageAddress = Facet.define<(src: string) => string | undefined, (src: string) => string | undefined>({ combine: values => values[0] ?? (() => undefined) });
const webImage = (src: string) => /^(https?:|data:image\/)/iu.test(src);

/** A picture written as ![alt](src) or Obsidian's ![[src|width]]. A broken one says what is missing instead of a broken-image icon. */
class Picture extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly address: string | undefined, readonly width: number | undefined, readonly alone: boolean) { super(); }
  eq(other: Picture) { return other.src === this.src && other.alt === this.alt && other.address === this.address && other.width === this.width && other.alone === this.alone; }
  toDOM(view: EditorView) {
    const holder = document.createElement('span');
    holder.className = this.alone ? 'cm-md-image cm-md-image-block' : 'cm-md-image';
    const missing = (why: string) => { holder.replaceChildren(); holder.classList.add('cm-md-image-missing'); holder.textContent = `${this.alt || this.src} · ${why}`; view.requestMeasure(); };
    if (!this.address) { missing('no project folder to read it from'); return holder; }
    const picture = document.createElement('img');
    picture.src = this.address; picture.alt = this.alt; picture.loading = 'lazy'; picture.draggable = false;
    if (this.alt) picture.title = this.alt;
    if (this.width) picture.style.width = `${this.width}px`;
    picture.addEventListener('load', () => view.requestMeasure());
    picture.addEventListener('error', () => missing('image not found'));
    holder.append(picture);
    return holder;
  }
  // Let a click through, so it places the caret on the image and shows its source.
  ignoreEvent() { return false; }
}

/** Embedded images: shown in place of their Markdown away from the caret, and under the line while it is being edited. A field, because the second is a block. */
function pictures(state: EditorState): DecorationSet {
  const found: Range<Decoration>[] = [], address = state.facet(imageAddress), text = state.doc.toString();
  const editing = (from: number, to: number) => state.field(focus) && state.selection.ranges.some(range => range.from <= to && range.to >= from);
  const embeds: { from: number; to: number; src: string; alt: string; width?: number }[] = [];
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  tree.iterate({ enter: node => {
    if (node.name === 'Table') return false;
    if (node.name !== 'Image') return;
    const url = node.node.getChild('URL'), marks = node.node.getChildren('LinkMark');
    if (!url || marks.length < 2) return false;
    const label = state.sliceDoc(marks[0].to, marks[1].from), sized = /^(.*?)\|\s*(\d{1,4})\s*$/su.exec(label);
    embeds.push({ from: node.from, to: node.to, src: state.sliceDoc(url.from, url.to), alt: sized ? sized[1] : label, width: sized ? Number(sized[2]) : undefined });
    return false;
  } });
  for (const match of text.matchAll(/!\[\[([^\]|\n]+?)(?:\|\s*(\d{1,4})\s*)?\]\]/gu)) {
    const from = match.index!;
    if (inCode(state, from)) continue;
    const name = match[1].trim();
    embeds.push({ from, to: from + match[0].length, src: name, alt: name.split('/').at(-1) ?? name, width: match[2] ? Number(match[2]) : undefined });
  }
  const under = new Map<number, Picture[]>();
  for (const embed of embeds.sort((a, b) => a.from - b.from)) {
    const line = state.doc.lineAt(embed.from), alone = !state.sliceDoc(line.from, embed.from).trim() && !state.sliceDoc(embed.to, line.to).trim();
    const picture = new Picture(embed.src, embed.alt, webImage(embed.src) ? embed.src : address(embed.src), embed.width, alone);
    if (!editing(line.from, line.to)) found.push(Decoration.replace({ widget: picture }).range(embed.from, embed.to));
    else under.set(line.to, [...(under.get(line.to) ?? []), new Picture(embed.src, embed.alt, picture.address, embed.width, true)]);
  }
  for (const [at, shown] of under) for (const picture of shown) found.push(Decoration.widget({ widget: picture, block: true, side: 1 }).range(at));
  return Decoration.set(found, true);
}
const images = StateField.define<DecorationSet>({
  create: pictures,
  update: (value, tr) => tr.docChanged || tr.selection || tr.effects.some(effect => effect.is(focused)) || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? pictures(tr.state) : value,
  provide: field => EditorView.decorations.from(field),
});

/** One cell's Markdown as DOM, from the parse tree: bold, italic, strikethrough, code, links and $formulas$, with their marks left out. */
function inlineDom(view: EditorView, state: EditorState, node: SyntaxNode, into: HTMLElement) {
  const text = (from: number, to: number) => {
    const value = state.sliceDoc(from, to);
    let at = 0;
    for (const match of value.matchAll(/(?<![\\$])\$(?![\s$])([^$\n]+?)(?<!\s)\$(?![$\d])/g)) {
      into.append(value.slice(at, match.index));
      const formula = document.createElement('span'); formula.className = 'cm-md-math';
      katex.render(match[1], formula, { throwOnError: false }); into.append(formula);
      at = match.index! + match[0].length;
    }
    into.append(value.slice(at));
  };
  const element = (tag: string, className?: string) => { const made = document.createElement(tag); if (className) made.className = className; into.append(made); return made; };
  let at = node.from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from > at) text(at, child.from);
    at = child.to;
    switch (child.name) {
      case 'URL':
        // A bare address or email (GFM autolink) shows as written; inside [text](url) it is the hidden target.
        if (node.name !== 'Link' && node.name !== 'Image') { const link = element('span', 'cm-md-link'); link.textContent = state.sliceDoc(child.from, child.to); }
        break;
      case 'EmphasisMark': case 'CodeMark': case 'LinkMark': case 'StrikethroughMark': case 'LinkTitle': case 'LinkLabel': break;
      case 'StrongEmphasis': inlineDom(view, state, child, element('strong')); break;
      case 'Emphasis': inlineDom(view, state, child, element('em')); break;
      case 'Strikethrough': inlineDom(view, state, child, element('s')); break;
      case 'InlineCode': inlineDom(view, state, child, element('code', 'cm-md-cell-code')); break;
      case 'Link': {
        const url = child.getChild('URL'), link = element('span', 'cm-md-link');
        if (url) link.title = state.sliceDoc(url.from, url.to);
        inlineDom(view, state, child, link);
        break;
      }
      case 'Image': {
        const url = child.getChild('URL'), marks = child.getChildren('LinkMark');
        if (!url || marks.length < 2) { text(child.from, child.to); break; }
        const src = state.sliceDoc(url.from, url.to), label = state.sliceDoc(marks[0].to, marks[1].from), sized = /^(.*?)\|\s*(\d{1,4})\s*$/su.exec(label);
        into.append(new Picture(src, sized ? sized[1] : label, webImage(src) ? src : state.facet(imageAddress)(src), sized ? Number(sized[2]) : undefined, false).toDOM(view));
        break;
      }
      case 'Escape': into.append(state.sliceDoc(child.from + 1, child.to)); break;
      default: inlineDom(view, state, child, into);
    }
  }
  if (node.to > at) text(at, node.to);
}

class Table extends WidgetType {
  constructor(readonly source: string, readonly build: (view: EditorView) => HTMLElement) { super(); }
  eq(other: Table) { return other.source === this.source; }
  toDOM(view: EditorView) { return this.build(view); }
  // Let a click through, so it places the caret in the table and shows its source.
  ignoreEvent() { return false; }
}

/** GFM tables as a real table, unless the caret is inside one. A field, because a table spans lines. */
function tableBlocks(state: EditorState): DecorationSet {
  const found: Range<Decoration>[] = [], editing = (from: number, to: number) => state.field(focus) && state.selection.ranges.some(range => range.from <= to && range.to >= from);
  (ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state)).iterate({ enter: node => {
    if (node.name !== 'Table') return;
    const from = state.doc.lineAt(node.from).from, to = state.doc.lineAt(node.to).to;
    if (editing(from, to)) return false;
    const table = node.node, delimiter = table.getChildren('TableDelimiter').find(mark => state.sliceDoc(mark.from, mark.to).includes('-'));
    // Column alignment from the |:---|:--:|---:| row.
    const align = delimiter ? state.sliceDoc(delimiter.from, delimiter.to).replace(/^\s*\|?|\|?\s*$/g, '').split('|').map(cell => { const value = cell.trim(); return value.startsWith(':') && value.endsWith(':') ? 'center' : value.endsWith(':') ? 'right' : value.startsWith(':') ? 'left' : ''; }) : [];
    const build = (view: EditorView) => {
      const wrap = document.createElement('div'); wrap.className = 'cm-md-table-wrap';
      const grid = document.createElement('table'); grid.className = 'cm-md-table'; wrap.append(grid);
      const head = grid.createTHead(), body = grid.createTBody();
      for (let row = table.firstChild; row; row = row.nextSibling) {
        if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue;
        const line = (row.name === 'TableHeader' ? head : body).insertRow(), cells = row.getChildren('TableCell');
        // A row with fewer cells still gets every column, as GitHub draws it.
        for (let column = 0; column < Math.max(cells.length, align.length); column++) {
          const cell = document.createElement(row.name === 'TableHeader' ? 'th' : 'td');
          if (align[column]) cell.style.textAlign = align[column];
          if (cells[column]) inlineDom(view, state, cells[column], cell);
          line.append(cell);
        }
      }
      return wrap;
    };
    found.push(Decoration.replace({ widget: new Table(state.sliceDoc(from, to), build), block: true }).range(from, to));
    return false;
  } });
  return Decoration.set(found, true);
}
const tables = StateField.define<DecorationSet>({
  create: tableBlocks,
  update: (value, tr) => tr.docChanged || tr.selection || tr.effects.some(effect => effect.is(focused)) || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? tableBlocks(tr.state) : value,
  provide: field => EditorView.decorations.from(field),
});

const preview = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = livePreview(view); }
  update(update: ViewUpdate) { if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = livePreview(update.view); }
}, { decorations: value => value.decorations });

/** A Markdown note you type into directly. Marks hide away from the caret, so the text reads like the rendered note. */
export function MarkdownEditor({ value, onChange, onBlur, imageUrl, readOnly = false, placeholder = '', ariaLabel, autoFocus = false }: { value: string; onChange(value: string): void; onBlur?(): void; /** The address of an embedded image that is not a web link, e.g. a file in the project folder. */ imageUrl?(src: string): string | undefined; readOnly?: boolean; placeholder?: string; ariaLabel: string; autoFocus?: boolean }) {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onBlur, imageUrl }); handlers.current = { onChange, onBlur, imageUrl };
  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: value, extensions: [
        history(), EditorView.lineWrapping, markdown({ base: markdownLanguage }), syntaxHighlighting(style), preview, focus, math, tables, images, imageAddress.of(src => handlers.current.imageUrl?.(src)), EditorView.focusChangeEffect.of((_, focusing) => focused.of(focusing)),
        keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        placeholderText(placeholder), EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
        EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: 'true' }),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !update.transactions.some(tr => tr.annotation(external))) handlers.current.onChange(update.state.doc.toString());
          if (update.focusChanged && !update.view.hasFocus) handlers.current.onBlur?.();
        }),
      ] }),
    });
    view.current = editor;
    if (autoFocus) editor.focus();
    return () => { editor.destroy(); view.current = null; };
  }, [readOnly]);
  useEffect(() => {
    const editor = view.current; if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value) editor.dispatch({ changes: difference(current, value), annotations: external.of(true) });
  }, [value]);
  const [bar, setBar] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const scroller = view.current?.scrollDOM; if (!scroller) return;
    const measure = () => {
      const { scrollTop, scrollHeight, clientHeight } = scroller;
      if (scrollHeight <= clientHeight + 1) { setBar(null); return; }
      const height = Math.max(32, clientHeight * clientHeight / scrollHeight);
      setBar({ height, top: (clientHeight - height) * scrollTop / (scrollHeight - clientHeight) });
    };
    const resize = new ResizeObserver(measure);
    resize.observe(scroller); resize.observe(view.current!.contentDOM);
    scroller.addEventListener('scroll', measure, { passive: true }); measure();
    return () => { resize.disconnect(); scroller.removeEventListener('scroll', measure); };
  }, [readOnly]);
  /** Drag the thumb, or press the track to jump there. */
  const drag = (event: React.PointerEvent<HTMLDivElement>, onThumb: boolean) => {
    const scroller = view.current?.scrollDOM; if (!scroller || !bar) return;
    event.preventDefault(); event.stopPropagation();
    const track = event.currentTarget.closest('.markdown-editor-scrollbar')!.getBoundingClientRect();
    const range = scroller.scrollHeight - scroller.clientHeight, travel = track.height - bar.height;
    const grab = onThumb ? event.clientY - track.top - bar.top : bar.height / 2;
    const to = (y: number) => { scroller.scrollTop = Math.min(1, Math.max(0, (y - track.top - grab) / travel)) * range; };
    if (!onThumb) to(event.clientY);
    const move = (moved: PointerEvent) => to(moved.clientY);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.classList.remove('markdown-editor-dragging'); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); document.body.classList.add('markdown-editor-dragging');
  };
  return <div className={`markdown-editor${readOnly ? ' read-only' : ''}`}>
    <div ref={host} className="markdown-editor-body" onMouseDown={event => {
      // Clicking the empty space under the text puts the caret at the end, like a page.
      const editor = view.current;
      if (!editor || readOnly || event.target !== host.current) return;
      event.preventDefault(); editor.focus(); editor.dispatch({ selection: { anchor: editor.state.doc.length } });
    }}/>
    {bar && <div className="markdown-editor-scrollbar" aria-hidden="true" onPointerDown={event => drag(event, false)}><div className="markdown-editor-thumb" style={{ top: bar.top, height: bar.height }} onPointerDown={event => drag(event, true)}/></div>}
  </div>;
}
