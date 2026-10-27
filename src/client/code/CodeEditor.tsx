import { useEffect, useRef, type MutableRefObject } from 'react';
import { Annotation, Compartment, EditorState, Prec, StateEffect, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, placeholder as placeholderText } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from '@codemirror/commands';
import { bracketMatching, ensureSyntaxTree, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, completionStatus } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { linter, lintGutter, lintKeymap, type Diagnostic } from '@codemirror/lint';
import { python, pythonLanguage } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { PostgreSQL, sql } from '@codemirror/lang-sql';
import { classHighlighter } from '@lezer/highlight';
import { rosCompletionSource } from './python-completions';
import type { CodeContext } from './context';
import type { TracebackLine } from './traceback';
import './code-editor.css';

export interface CodeEditorApi { insert(text: string): void; focus(at?: 'start' | 'end'): void }
export interface ErrorMark extends TracebackLine { message: string; primary: boolean }
export interface CodeEditorProps {
  value: string;
  onChange(value: string): void;
  language: string;
  ariaLabel: string;
  context?: CodeContext;
  errors?: ErrorMark[];
  readOnly?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  maxLength?: number;
  compact?: boolean;
  /** Line numbers show by default; notebook cells leave them out, as Jupyter does. */
  lineNumbers?: boolean;
  /** For SQL: the tables a query can use and their columns, offered as completions. */
  sqlSchema?: Record<string, string[]>;
  onRun?(): void;
  onSave?(): void;
  /** Notebook keys: Shift+Enter, Escape, and arrow keys that leave the first or last line. */
  onShiftEnter?(): void;
  onEscape?(): void;
  onEdge?(direction: 'up' | 'down'): boolean;
  apiRef?: MutableRefObject<CodeEditorApi | null>;
}

const external = Annotation.define<boolean>();
// Re-lints when the last attempt's error marks change without a document edit.
const refreshMarks = StateEffect.define<null>();

/** The smallest single change turning `current` into `next`, so the caret and undo history map through it. */
function difference(current: string, next: string) {
  let from = 0;
  const limit = Math.min(current.length, next.length);
  while (from < limit && current.charCodeAt(from) === next.charCodeAt(from)) from++;
  let end = 0;
  while (end < limit - from && current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end++;
  return { from, to: current.length - end, insert: next.slice(from, next.length - end) };
}
const plainContext: CodeContext = { runtime: 'docker', columns: null, paramKeys: [] };

function languageExtensions(language: string, readContext: () => CodeContext, sqlSchema?: Record<string, string[]>): Extension {
  const name = language.trim().toLowerCase();
  if (name === 'json') return json();
  // DuckDB's SQL is close to PostgreSQL's.
  if (name === 'sql') return sql({ dialect: PostgreSQL, schema: sqlSchema, upperCaseKeywords: true });
  if (name !== 'python') return [];
  return [python(), pythonLanguage.data.of({ autocomplete: rosCompletionSource(readContext) })];
}

/** Live syntax errors from the Python parse tree, plus marks from the last failed attempt. */
function diagnostics(view: EditorView, language: string, errors: ErrorMark[]): Diagnostic[] {
  const { state } = view, found: Diagnostic[] = [];
  if (language.trim().toLowerCase() === 'python') {
    const tree = ensureSyntaxTree(state, state.doc.length, 200);
    tree?.iterate({ enter: node => {
      if (!node.type.isError || found.length >= 20) return;
      const from = Math.min(node.from, state.doc.length), to = Math.min(Math.max(node.to, from + 1), state.doc.length);
      found.push({ from, to, severity: 'warning', message: 'Python cannot parse this. Check brackets, colons and indentation.' });
    } });
  }
  for (const mark of errors) {
    if (mark.line < 1 || mark.line > state.doc.lines) continue;
    const line = state.doc.line(mark.line), indent = line.text.length - line.text.trimStart().length;
    const from = mark.column === null ? line.from : Math.min(line.to, line.from + indent + mark.column);
    found.push({ from, to: mark.column === null ? line.to : Math.min(line.to, from + 1), severity: mark.primary ? 'error' : 'info', message: mark.message, source: 'Last attempt' });
  }
  return found;
}

export default function CodeEditor(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null);
  const latest = useRef(props); latest.current = props;
  const languageSlot = useRef(new Compartment()), readOnlySlot = useRef(new Compartment()), placeholderSlot = useRef(new Compartment());

  useEffect(() => {
    const readContext = () => latest.current.context ?? plainContext;
    const shortcuts = Prec.highest(keymap.of([
      { key: 'Mod-Enter', run: () => { latest.current.onRun?.(); return Boolean(latest.current.onRun); } },
      // Saving the page itself is never useful here, so Mod-s is always consumed.
      { key: 'Mod-s', run: () => { latest.current.onSave?.(); return true; }, preventDefault: true },
      { key: 'Shift-Enter', run: () => { latest.current.onShiftEnter?.(); return Boolean(latest.current.onShiftEnter); } },
      // An open suggestion list keeps Escape and the arrow keys.
      { key: 'Escape', run: current => { if (!latest.current.onEscape || completionStatus(current.state) === 'active') return false; latest.current.onEscape(); return true; } },
      { key: 'ArrowUp', run: current => edge(current, 'up') },
      { key: 'ArrowDown', run: current => edge(current, 'down') },
    ]));
    const edge = (current: EditorView, direction: 'up' | 'down') => {
      const { main } = current.state.selection, line = current.state.doc.lineAt(main.head);
      if (!latest.current.onEdge || !main.empty || completionStatus(current.state) === 'active' || line.number !== (direction === 'up' ? 1 : current.state.doc.lines)) return false;
      return latest.current.onEdge(direction);
    };
    const created = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          shortcuts,
          props.lineNumbers === false ? [] : lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), dropCursor(),
          indentOnInput(), bracketMatching(), closeBrackets(), highlightActiveLine(), highlightSelectionMatches(),
          syntaxHighlighting(classHighlighter),
          autocompletion({ activateOnTyping: true, icons: false }),
          lintGutter(),
          linter(current => diagnostics(current, latest.current.language, latest.current.errors ?? []), { delay: 400, needsRefresh: update => update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshMarks))) }),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
          languageSlot.current.of(languageExtensions(props.language, readContext, props.sqlSchema)),
          readOnlySlot.current.of([EditorState.readOnly.of(Boolean(props.readOnly)), EditorView.editable.of(!props.readOnly)]),
          EditorState.tabSize.of(4),
          // The length limit stops typing that grows the text past it; deletions and values loaded from saved records always apply.
          EditorState.transactionFilter.of(transaction => transaction.docChanged && !transaction.annotation(external) && transaction.newDoc.length > (latest.current.maxLength ?? 100_000) && transaction.newDoc.length > transaction.startState.doc.length ? [] : transaction),
          EditorView.contentAttributes.of({ 'aria-label': props.ariaLabel, spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
          placeholderSlot.current.of(props.placeholder ? placeholderText(props.placeholder) : []),
          EditorView.updateListener.of(update => {
            if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(external))) latest.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = created;
    if (props.autoFocus) created.focus();
    if (props.apiRef) props.apiRef.current = {
      focus: at => {
        if (at) created.dispatch({ selection: { anchor: at === 'start' ? 0 : created.state.doc.length }, scrollIntoView: true });
        created.focus();
      },
      insert: text => {
        if (latest.current.readOnly) return;
        const { from, to } = created.state.selection.main;
        created.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true, userEvent: 'input' });
        created.focus();
      },
    };
    return () => { created.destroy(); view.current = null; if (props.apiRef) props.apiRef.current = null; };
    // The view is created once; later prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const current = view.current;
    if (!current || current.state.doc.toString() === props.value) return;
    // Loaded values (starters, saved records, workspace undo) are their own undo step, so Mod-z restores the previous text.
    current.dispatch({ changes: difference(current.state.doc.toString(), props.value), annotations: [external.of(true), isolateHistory.of('full')] });
  }, [props.value]);
  const schemaKey = JSON.stringify(props.sqlSchema ?? null);
  useEffect(() => {
    view.current?.dispatch({ effects: [languageSlot.current.reconfigure(languageExtensions(props.language, () => latest.current.context ?? plainContext, latest.current.sqlSchema)), refreshMarks.of(null)] });
  }, [props.language, schemaKey]);
  useEffect(() => {
    view.current?.dispatch({ effects: placeholderSlot.current.reconfigure(props.placeholder ? placeholderText(props.placeholder) : []) });
  }, [props.placeholder]);
  useEffect(() => {
    view.current?.dispatch({ effects: readOnlySlot.current.reconfigure([EditorState.readOnly.of(Boolean(props.readOnly)), EditorView.editable.of(!props.readOnly)]) });
  }, [props.readOnly]);
  useEffect(() => { view.current?.dispatch({ effects: refreshMarks.of(null) }); }, [props.errors]);

  return <div ref={host} className={`code-editor${props.compact ? ' compact' : ''}${props.readOnly ? ' read-only' : ''}`} />;
}
