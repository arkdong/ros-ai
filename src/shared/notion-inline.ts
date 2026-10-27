/** One line of a Notion page in Notion-flavored Markdown, as the page editor holds it: what kind of block it is and
 * its words as runs of text with their formatting. The editor shows the runs formatted (no Markdown marks) and turns
 * them back into Notion's text when the person saves. Mentions, dates and other tags Notion writes inline stay
 * whole ("atoms"), so an edit around them keeps them. */

export type LineKind = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'bullet' | 'number' | 'todo' | 'quote';
/** b, i, s and code are emphasis; `a:<url>` a link; `t:<name>:<opening tag>` a Notion tag that wraps words (colour, underline). */
export type Mark = string;
export type Run = { text: string; marks: Mark[] } | { atom: string; marks: Mark[] };
export type Line = { kind: LineKind; checked: boolean; runs: Run[]; indent: string; tail: string };

const HEADING: Record<string, LineKind> = { '#': 'h1', '##': 'h2', '###': 'h3', '####': 'h4' };
const PREFIX: Record<LineKind, string> = { p: '', h1: '# ', h2: '## ', h3: '### ', h4: '#### ', bullet: '- ', number: '1. ', todo: '- [ ] ', quote: '> ' };
/** Tags whose words are part of the tag (a mention's title, a date): kept as one piece. */
const ATOMIC = /^(mention[\w-]*|date|page|database|folder|link-preview|equation)$/u;
const EMPHASIS: Record<string, Mark> = { b: 'b', strong: 'b', i: 'i', em: 'i', s: 's', del: 's', strike: 's', code: 'code' };

/** A line of Notion's text as a block kind and its runs. */
export function parseLine(source: string): Line {
  const [, indent = '', rest = ''] = source.match(/^(\s*)([\s\S]*)$/u) ?? [];
  let kind: LineKind = 'p', checked = false, body = rest;
  const heading = rest.match(/^(#{1,4}) ([\s\S]*)$/u), todo = rest.match(/^[-*+] \[( |x|X)\] ([\s\S]*)$/u), bullet = rest.match(/^[-*+] ([\s\S]*)$/u), number = rest.match(/^\d+[.)] ([\s\S]*)$/u), quote = rest.match(/^> ?([\s\S]*)$/u);
  if (heading) { kind = HEADING[heading[1]]; body = heading[2]; }
  else if (todo) { kind = 'todo'; checked = todo[1] !== ' '; body = todo[2]; }
  else if (bullet) { kind = 'bullet'; body = bullet[1]; }
  else if (number) { kind = 'number'; body = number[1]; }
  else if (quote) { kind = 'quote'; body = quote[1]; }
  // A block's colour is written after its words.
  const tail = body.match(/\s*\{color="[^"]*"\}\s*$/u)?.[0] ?? '';
  return { kind, checked, runs: parseInline(tail ? body.slice(0, -tail.length) : body), indent, tail: tail.trim() ? ` ${tail.trim()}` : '' };
}

/** Notion's inline Markdown as runs. A mark left open runs to the end of the line, as Notion would show it. */
export function parseInline(text: string, outer: Mark[] = []): Run[] {
  const runs: Run[] = [];
  let marks = [...outer], buffer = '';
  const flush = () => { if (buffer) runs.push({ text: buffer, marks: [...marks] }); buffer = ''; };
  const toggle = (mark: Mark) => { flush(); marks = marks.includes(mark) ? marks.filter(item => item !== mark) : [...marks, mark]; };
  for (let at = 0; at < text.length;) {
    const rest = text.slice(at), char = text[at];
    if (marks.includes('code')) {
      if (char === '`') { toggle('code'); at++; } else { buffer += char; at++; }
      continue;
    }
    if (char === '\\' && at + 1 < text.length) { buffer += text[at + 1]; at += 2; continue; }
    if (rest.startsWith('**')) { toggle('b'); at += 2; continue; }
    if (rest.startsWith('~~')) { toggle('s'); at += 2; continue; }
    if (char === '*') { toggle('i'); at++; continue; }
    if (char === '`') { toggle('code'); at++; continue; }
    if (char === '[') {
      const link = rest.match(/^\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/u);
      if (link) { flush(); runs.push(...parseInline(link[1], [...marks, `a:${link[2]}`])); at += link[0].length; continue; }
    }
    if (char === '<') {
      const tag = rest.match(/^<(\/?)([a-zA-Z][\w-]*)((?:\s[^<>]*?)?)\s*(\/?)>/u);
      if (tag) {
        const [whole, closing, rawName, , selfClosing] = tag, name = rawName.toLowerCase();
        if (name === 'br') { buffer += '\n'; at += whole.length; continue; }
        if (EMPHASIS[name]) { flush(); const mark = EMPHASIS[name]; marks = closing ? marks.filter(item => item !== mark) : marks.includes(mark) ? marks : [...marks, mark]; at += whole.length; continue; }
        if (!closing && (selfClosing || ATOMIC.test(name))) {
          const end = selfClosing ? -1 : rest.indexOf(`</${rawName}>`);
          const raw = selfClosing || end < 0 ? whole : rest.slice(0, end + rawName.length + 3);
          flush(); runs.push({ atom: raw, marks: [...marks] }); at += raw.length; continue;
        }
        flush();
        if (closing) { const index = marks.map(mark => mark.startsWith(`t:${name}:`)).lastIndexOf(true); if (index >= 0) marks = marks.filter((_, i) => i !== index); }
        else marks = [...marks, `t:${name}:${whole}`];
        at += whole.length; continue;
      }
    }
    buffer += char; at++;
  }
  flush();
  return runs;
}

/** Links outside, then Notion's tags, then emphasis, code innermost: the order marks open in. */
const rank = (mark: Mark) => mark.startsWith('a:') ? 0 : mark.startsWith('t:') ? 1 : mark === 'b' ? 2 : mark === 'i' ? 3 : mark === 's' ? 4 : 5;
const ordered = (marks: Mark[]) => [...new Set(marks)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
const opener = (mark: Mark) => mark.startsWith('a:') ? '[' : mark.startsWith('t:') ? mark.slice(mark.indexOf(':', 2) + 1) : mark === 'b' ? '**' : mark === 'i' ? '*' : mark === 's' ? '~~' : '`';
const closer = (mark: Mark) => mark.startsWith('a:') ? `](${mark.slice(2)})` : mark.startsWith('t:') ? `</${mark.split(':')[1]}>` : opener(mark);
const escape = (text: string) => text.replace(/[\\*~`[\]<]/gu, '\\$&').replace(/\n/gu, '<br>');
const same = (a: Mark[], b: Mark[]) => a.length === b.length && a.every((mark, index) => mark === b[index]);

/** Neighbouring text with the same marks as one run; spaces at a run's edges moved outside its emphasis, where
 * Markdown needs them. */
export function tidy(runs: Run[]): Run[] {
  const merged: Run[] = [];
  for (const run of runs) {
    const marks = ordered(run.marks), last = merged[merged.length - 1];
    if ('text' in run) {
      if (!run.text) continue;
      if (last && 'text' in last && same(last.marks, marks)) { last.text += run.text; continue; }
      merged.push({ text: run.text, marks });
    } else merged.push({ atom: run.atom, marks });
  }
  return merged.flatMap(run => {
    if (!('text' in run) || run.marks.includes('code') || !run.marks.some(mark => ['b', 'i', 's'].includes(mark))) return [run];
    const [, before, words, after] = run.text.match(/^(\s*)([\s\S]*?)(\s*)$/u)!;
    const plain = run.marks.filter(mark => !['b', 'i', 's'].includes(mark));
    if (!words) return [{ text: run.text, marks: plain }];
    return [...(before ? [{ text: before, marks: plain }] : []), { text: words, marks: run.marks }, ...(after ? [{ text: after, marks: plain }] : [])];
  });
}

/** Runs as Notion's inline Markdown. */
export function inlineMarkdown(runs: Run[]): string {
  const open: Mark[] = [];
  let out = '';
  for (const run of tidy(runs)) {
    const marks = run.marks;
    // Keep the open marks this run still has (code only when nothing opens inside it), close the rest, open what is new.
    let keep = 0;
    while (keep < open.length && marks.includes(open[keep])) keep++;
    const adding = marks.filter(mark => !open.slice(0, keep).includes(mark));
    if (adding.length && open.slice(0, keep).includes('code')) keep = open.indexOf('code');
    while (open.length > keep) out += closer(open.pop()!);
    for (const mark of marks.filter(mark => !open.includes(mark))) { out += opener(mark); open.push(mark); }
    out += 'atom' in run ? run.atom : marks.includes('code') ? run.text.replace(/`/gu, '').replace(/\n/gu, ' ') : escape(run.text);
  }
  while (open.length) out += closer(open.pop()!);
  return out;
}

/** A line as Notion's text. Words that would read as a block mark at the start are escaped. */
export function lineMarkdown(line: Line): string {
  let words = inlineMarkdown(line.runs);
  if (line.kind === 'p' || line.kind === 'quote') words = words.replace(/^(#{1,6} |[-+] |\d+[.)] |> )/u, '\\$1');
  if (!words.trim()) return '';
  const prefix = line.kind === 'todo' ? `- [${line.checked ? 'x' : ' '}] ` : PREFIX[line.kind];
  return `${line.indent}${prefix}${words}${line.tail}`;
}

/** The words of a line without any formatting. */
export const plainText = (runs: Run[]) => runs.map(run => 'text' in run ? run.text : '').join('');
