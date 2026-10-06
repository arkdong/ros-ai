import { Suspense, lazy, useEffect, useState } from 'react';
import type { CodeEditorProps } from './CodeEditor';
import type { Token } from './highlight';
import './code-editor.css';

/** Label for the platform's command modifier in shortcut hints. */
export const modKey = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

export type { CodeEditorApi, CodeEditorProps, ErrorMark } from './CodeEditor';

function PlainEditor(props: CodeEditorProps) {
  return <textarea className={`code-input code-editor-fallback${props.compact ? ' compact' : ''}`} aria-label={props.ariaLabel} value={props.value} readOnly={props.readOnly} spellCheck={false} placeholder={props.placeholder} onChange={event => props.onChange(event.target.value)} />;
}

// CodeMirror loads only when an editor opens, keeping it out of the main bundle. If its chunk
// cannot load (for example after an update while this tab stayed open), the plain textarea stays.
const LazyEditor = lazy(() => import('./CodeEditor').catch(() => ({ default: PlainEditor })));

/** Editor with highlighting and completion. A plain textarea stands in while it loads. */
export function CodeEditor(props: CodeEditorProps) {
  return <Suspense fallback={<PlainEditor {...props} />}>
    <LazyEditor {...props} />
  </Suspense>;
}

let loading: Promise<typeof import('./highlight')> | null = null;

/** Read-only highlighted source for saved code (attempts, approvals, artifacts, notebook cells). */
export function CodeView({ code, language = 'python', className = '' }: { code: string; language?: string; className?: string }) {
  const python = language.trim().toLowerCase() === 'python';
  const [lines, setLines] = useState<Token[][] | null>(null);
  useEffect(() => {
    if (!python) { setLines(null); return; }
    let live = true;
    void (loading ??= import('./highlight')).then(module => { if (live) setLines(module.highlightPython(code)); }).catch(() => undefined);
    return () => { live = false; };
  }, [code, python]);
  return <pre className={`code-view ${className}`} tabIndex={0}>{lines
    ? lines.map((line, index) => <span key={index}>{line.map((token, at) => token.className ? <span key={at} className={token.className}>{token.text}</span> : token.text)}{index < lines.length - 1 ? '\n' : ''}</span>)
    : code}</pre>;
}
