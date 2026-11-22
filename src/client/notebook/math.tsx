import { useLayoutEffect, useRef } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

/** A LaTeX formula drawn by KaTeX, inline or on its own line. A formula KaTeX can't read shows its source in red. */
export function Formula({ tex, block = false }: { tex: string; block?: boolean }) {
  const holder = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const into = holder.current;
    if (!into) return;
    try { katex.render(tex, into, { displayMode: block, throwOnError: false, strict: 'ignore' }); }
    catch { into.textContent = tex; into.classList.add('nb-math-source'); }
  }, [tex, block]);
  return <span ref={holder} className={block ? 'nb-math nb-math-block' : 'nb-math'}/>;
}

/** The formula inside a text/latex output, without the $$ … $$, $ … $, \[ … \] or \( … \) around it. */
export function unwrapLatex(text: string): string {
  const trimmed = text.trim();
  for (const [open, close] of [['$$', '$$'], ['\\[', '\\]'], ['\\(', '\\)'], ['$', '$']]) {
    if (trimmed.length > open.length + close.length && trimmed.startsWith(open) && trimmed.endsWith(close)) return trimmed.slice(open.length, -close.length).trim();
  }
  return trimmed;
}
