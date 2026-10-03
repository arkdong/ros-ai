/** Program line numbers named in a captured Python traceback, innermost (the failing line) last. */
/** `column` counts from the first non-space character of the line (Python prints the line trimmed). */
export interface TracebackLine { line: number; column: number | null }

const frame = /File "(?:\/input\/program\.py|<research-program>)", line (\d+)/g;

export function tracebackLines(stderr: string): TracebackLine[] {
  // Only the final traceback names the failure; earlier chained or printed ones are context.
  const start = stderr.lastIndexOf('Traceback (most recent call last):');
  const text = start >= 0 ? stderr.slice(start) : stderr;
  const found: TracebackLine[] = [];
  let end = -1;
  for (const match of text.matchAll(frame)) { found.push({ line: Number(match[1]), column: null }); end = match.index + match[0].length; }
  const last = found.at(-1);
  // SyntaxError tracebacks print the source line followed by a caret line under the error.
  if (last && /SyntaxError|IndentationError|TabError/.test(text)) {
    const after = text.slice(end).split('\n');
    const source = after[1], caret = after[2];
    if (source !== undefined && caret && /^\s*\^+\s*$/.test(caret)) last.column = Math.max(0, caret.indexOf('^') - (source.length - source.trimStart().length));
  }
  return found;
}

/** The stderr and error message inside a captured execution log artifact. */
export function logFailure(content: string): { stderr: string; error: string } | null {
  try {
    const data = JSON.parse(content) as { stderr?: unknown; error?: unknown };
    if (!data.error) return null;
    return { stderr: typeof data.stderr === 'string' ? data.stderr : '', error: String(data.error) };
  } catch { return null; }
}
