import { useEffect, useRef, useState } from 'react';
import { Annotation, EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, placeholder as placeholderText, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';
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

/** Live preview: render headings, emphasis, links, lists, tasks, quotes and rules in place and hide their marks away from the caret. */
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

const preview = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = livePreview(view); }
  update(update: ViewUpdate) { if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = livePreview(update.view); }
}, { decorations: value => value.decorations });

/** A Markdown note you type into directly. Marks hide away from the caret, so the text reads like the rendered note. */
export function MarkdownEditor({ value, onChange, onBlur, readOnly = false, placeholder = '', ariaLabel, autoFocus = false }: { value: string; onChange(value: string): void; onBlur?(): void; readOnly?: boolean; placeholder?: string; ariaLabel: string; autoFocus?: boolean }) {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onBlur }); handlers.current = { onChange, onBlur };
  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: value, extensions: [
        history(), EditorView.lineWrapping, markdown({ base: markdownLanguage }), syntaxHighlighting(style), preview,
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
