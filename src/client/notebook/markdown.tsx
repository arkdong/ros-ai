import { Fragment, type ReactNode } from 'react';
import { CodeView } from '../code';
import { safeUrl } from '../Content';

type Attachments = Record<string, unknown> | undefined;

const fence = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/u;
const heading = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/u;
const rule = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/u;
const quote = /^ {0,3}>\s?/u;
const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/u;
const tableRule = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/u;
const images = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Markdown cells and Markdown outputs, drawn as React elements. Nothing is inserted as HTML,
 * images from the web show as links instead of loading, and formulas stay as written. */
export function Markdown({ text, attachments }: { text: string; attachments?: Attachments }) {
  return <div className="nb-markdown">{blocks(text.replace(/\r\n?/gu, '\n').split('\n'), attachments)}</div>;
}

function blocks(lines: string[], attachments: Attachments): ReactNode[] {
  const out: ReactNode[] = [];
  for (let at = 0; at < lines.length;) {
    const line = lines[at], key = out.length;
    if (!line.trim()) { at++; continue; }
    const open = fence.exec(line);
    if (open) {
      const body: string[] = [];
      for (at++; at < lines.length && !lines[at].trimStart().startsWith(open[1]); at++) body.push(lines[at]);
      at++;
      out.push(<CodeView key={key} className="nb-md-code" code={body.join('\n')} language={open[2] || 'text'}/>);
      continue;
    }
    const title = heading.exec(line);
    if (title) {
      const Tag = `h${title[1].length}` as 'h1';
      out.push(<Tag key={key}>{inline(title[2], attachments)}</Tag>); at++; continue;
    }
    if (rule.test(line)) { out.push(<hr key={key}/>); at++; continue; }
    if (quote.test(line)) {
      const body: string[] = [];
      while (at < lines.length && lines[at].trim() && quote.test(lines[at])) body.push(lines[at++].replace(quote, ''));
      out.push(<blockquote key={key}>{blocks(body, attachments)}</blockquote>);
      continue;
    }
    if (item.test(line)) {
      const body: string[] = [];
      // A list runs on through indented lines, and through a blank line followed by more of it.
      while (at < lines.length && (item.test(lines[at]) || /^\s+\S/u.test(lines[at]) || (!lines[at].trim() && at + 1 < lines.length && (item.test(lines[at + 1]) || /^\s+\S/u.test(lines[at + 1]))))) body.push(lines[at++]);
      out.push(<Fragment key={key}>{list(body, attachments)}</Fragment>);
      continue;
    }
    if (line.includes('|') && at + 1 < lines.length && lines[at + 1].includes('-') && tableRule.test(lines[at + 1])) {
      const rows = [line];
      for (at += 2; at < lines.length && lines[at].includes('|') && lines[at].trim(); at++) rows.push(lines[at]);
      out.push(table(rows, key, attachments));
      continue;
    }
    const body = [line];
    for (at++; at < lines.length && lines[at].trim() && ![fence, heading, rule, quote, item].some(pattern => pattern.test(lines[at])); at++) body.push(lines[at]);
    out.push(<p key={key}>{inline(body.join('\n'), attachments)}</p>);
  }
  return out;
}

function list(lines: string[], attachments: Attachments): ReactNode {
  const first = item.exec(lines[0])!, indent = first[1].length, ordered = /\d/u.test(first[2]);
  const items: { text: string[]; children: string[] }[] = [];
  for (const line of lines) {
    const match = item.exec(line), current = items.at(-1);
    if (match && match[1].length <= indent) items.push({ text: [match[3]], children: [] });
    // Deeper items, and everything after them, belong to the item above.
    else if (current && (match || current.children.length)) current.children.push(line);
    else current?.text.push(line.trim());
  }
  const entries = items.map((value, index) => {
    const text = value.text.join(' ').trim(), task = /^\[([ xX])\]\s+/u.exec(text);
    return <li key={index} className={task ? 'nb-task' : undefined}>{task && <input type="checkbox" checked={task[1] !== ' '} disabled aria-label={task[1] !== ' ' ? 'Done' : 'Not done'}/>}{inline(task ? text.slice(task[0].length) : text, attachments)}{value.children.length > 0 && blocks(dedent(value.children), attachments)}</li>;
  });
  const start = Number.parseInt(first[2], 10);
  return ordered ? <ol start={start === 1 ? undefined : start}>{entries}</ol> : <ul>{entries}</ul>;
}
function dedent(lines: string[]): string[] {
  const depth = Math.min(...lines.filter(line => line.trim()).map(line => line.length - line.trimStart().length));
  return lines.map(line => line.slice(Math.min(depth, line.length - line.trimStart().length)));
}

function table(rows: string[], key: number, attachments: Attachments): ReactNode {
  const cells = (row: string) => row.trim().replace(/^\|/u, '').replace(/(?<!\\)\|$/u, '').split(/(?<!\\)\|/u).map(cell => cell.trim().replaceAll('\\|', '|'));
  const [head, ...body] = rows.map(cells);
  return <div key={key} className="nb-table-wrap"><table className="data-table"><thead><tr>{head.map((cell, index) => <th key={index}>{inline(cell, attachments)}</th>)}</tr></thead>
    <tbody>{body.map((row, index) => <tr key={index}>{head.map((_, column) => <td key={column}>{inline(row[column] ?? '', attachments)}</td>)}</tr>)}</tbody></table></div>;
}

// Code, images, links, web addresses, bold, struck, italic, formulas, line breaks and escaped characters, in that order.
const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)|\[([^\]]+)\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)|<(https?:\/\/[^\s>]+)>|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^\s*](?:[\s\S]*?[^\s*])?)\*|(?<!\w)_([^\s_](?:[\s\S]*?[^\s_])?)_(?!\w)|\$\$([\s\S]+?)\$\$|\$([^\s$](?:[^$\n]*?[^\s$])?)\$|<br\s*\/?>|( {2,}|\\)\n|\\([\\`*_{}[\]()#+\-.!|$<>~])/gu;

function inline(text: string, attachments: Attachments): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > at) out.push(text.slice(at, match.index));
    at = match.index + match[0].length;
    const key = `${match.index}`;
    const [, , code, alt, src, label, href, angle, bare, strong, strongToo, struck, emphasis, emphasisToo, display, formula, , escaped] = match;
    if (code !== undefined) out.push(<code key={key}>{code.replace(/^ (.+) $/su, '$1')}</code>);
    else if (src !== undefined) out.push(<Fragment key={key}>{image(alt ?? '', src, attachments)}</Fragment>);
    else if (href !== undefined) { const url = safeUrl(href); out.push(url ? <a key={key} href={url} target="_blank" rel="noreferrer noopener">{inline(label ?? '', attachments)}</a> : <Fragment key={key}>{inline(label ?? '', attachments)}</Fragment>); }
    else if (angle !== undefined || bare !== undefined) { const url = safeUrl(angle ?? bare); out.push(url ? <a key={key} href={url} target="_blank" rel="noreferrer noopener">{angle ?? bare}</a> : angle ?? bare); }
    else if (strong !== undefined || strongToo !== undefined) out.push(<strong key={key}>{inline(strong ?? strongToo ?? '', attachments)}</strong>);
    else if (struck !== undefined) out.push(<s key={key}>{inline(struck, attachments)}</s>);
    else if (emphasis !== undefined || emphasisToo !== undefined) out.push(<em key={key}>{inline(emphasis ?? emphasisToo ?? '', attachments)}</em>);
    else if (display !== undefined || formula !== undefined) out.push(<code key={key} className="nb-math" title="Formula, shown as written">{display ?? formula}</code>);
    else if (escaped !== undefined) out.push(escaped);
    else out.push(<br key={key}/>);
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Pictures attached to the cell show; pictures on the web stay links, so opening a notebook loads nothing from outside. */
function image(alt: string, src: string, attachments: Attachments): ReactNode {
  const attached = src.startsWith('attachment:') ? attachments?.[decodeURIComponent(src.slice(11))] : undefined;
  if (attached && typeof attached === 'object') {
    const bundle = attached as Record<string, unknown>, mime = images.find(type => typeof bundle[type] === 'string');
    if (mime) return <img src={`data:${mime};base64,${String(bundle[mime]).replace(/\s/gu, '')}`} alt={alt}/>;
  }
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/u.test(src)) return <img src={src} alt={alt}/>;
  const url = safeUrl(src);
  return url ? <a href={url} target="_blank" rel="noreferrer noopener" className="nb-image-link">Image: {alt || url}</a> : <span className="nb-image-link">Image: {alt || src}</span>;
}
