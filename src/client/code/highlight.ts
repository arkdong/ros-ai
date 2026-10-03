import { highlightCode, classHighlighter } from '@lezer/highlight';
import { parser } from '@lezer/python';

export type Token = { text: string; className: string };

/** Splits Python source into lines of class-tagged tokens using the same classes as the editor. */
export function highlightPython(source: string): Token[][] {
  const lines: Token[][] = [[]];
  highlightCode(source, parser.parse(source), classHighlighter,
    (text, className) => { lines[lines.length - 1].push({ text, className }); },
    () => { lines.push([]); });
  return lines;
}
