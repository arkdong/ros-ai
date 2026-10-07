import { useMemo, type ReactNode } from 'react';
import type { NotebookOutput } from '../../shared/notebooks';
import { parseCsv } from '../../shared/data-view';
import { Markdown } from './markdown';

const ROWS = 200;
const text = (value: unknown) => typeof value === 'string' ? value : Array.isArray(value) && value.every(item => typeof item === 'string') ? value.join('') : undefined;

/** Output text as a terminal shows it: no colour codes, and a progress bar redrawn with \r keeps its last state. */
export function plainOutput(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '').replace(/\r\n/gu, '\n')
    .split('\n').map(line => line.split('\r').findLast(part => part) ?? '').join('\n');
}

type Cell = { text: string; header: boolean; span: number };
/** The first table of an HTML output (how pandas shows a DataFrame), read as text. The HTML itself never reaches the page. */
function htmlTable(html: string): { head: Cell[][]; body: Cell[][] } | null {
  if (!/<table[\s>]/iu.test(html)) return null;
  // DOMParser documents are inert: their scripts never run and their images never load.
  const table = new DOMParser().parseFromString(html, 'text/html').querySelector('table');
  if (!table) return null;
  const row = (element: Element) => [...element.children].filter(cell => cell.tagName === 'TH' || cell.tagName === 'TD')
    .map(cell => ({ text: (cell.textContent ?? '').trim(), header: cell.tagName === 'TH', span: Math.min(50, Math.max(1, Number(cell.getAttribute('colspan')) || 1)) }));
  const head = [...table.querySelectorAll(':scope > thead > tr')].map(row);
  const body = [...table.querySelectorAll(':scope > tbody > tr, :scope > tr')].map(row);
  return head.length || body.length ? { head, body } : null;
}

function Table({ head, body, note }: { head: Cell[][]; body: Cell[][]; note?: string }) {
  const cell = (value: Cell, index: number) => value.header ? <th key={index} colSpan={value.span > 1 ? value.span : undefined}>{value.text}</th> : <td key={index} colSpan={value.span > 1 ? value.span : undefined}>{value.text}</td>;
  return <div className="nb-table"><div className="nb-table-scroll"><table>
    {head.length > 0 && <thead>{head.map((row, index) => <tr key={index}>{row.map(cell)}</tr>)}</thead>}
    <tbody>{body.map((row, index) => <tr key={index}>{row.map(cell)}</tr>)}</tbody>
  </table></div>{note && <small>{note}</small>}</div>;
}

function CsvTable({ csv }: { csv: string }) {
  const rows = useMemo(() => { try { return parseCsv(csv); } catch { return null; } }, [csv]);
  if (!rows?.length) return <pre className="nb-text">{csv}</pre>;
  const [head, ...body] = rows, toCells = (row: string[]) => row.map(value => ({ text: value, header: false, span: 1 }));
  return <Table head={[head.map(value => ({ text: value, header: true, span: 1 }))]} body={body.slice(0, ROWS).map(toCells)} note={body.length > ROWS ? `Showing ${ROWS} of ${body.length.toLocaleString()} rows. Save it as a result to see every row.` : undefined}/>;
}

function size(metadata: Record<string, unknown>, mime: string): { width?: number } {
  const own = metadata[mime], value = (own && typeof own === 'object' ? (own as Record<string, unknown>).width : undefined) ?? metadata.width;
  return typeof value === 'number' && value > 0 && value < 5000 ? { width: value } : {};
}

/** Rich output, richest safe form first. HTML other than tables is never shown. */
function Rich({ data, metadata }: { data: Record<string, unknown>; metadata: Record<string, unknown> }) {
  const image = ['image/png', 'image/jpeg', 'image/gif'].find(mime => /^[A-Za-z0-9+/\s]+={0,2}\s*$/u.test(text(data[mime]) ?? ''));
  if (image) return <img className="nb-image" src={`data:${image};base64,${text(data[image])!.replace(/\s/gu, '')}`} alt="Figure output" style={size(metadata, image)}/>;
  const svg = text(data['image/svg+xml']);
  // An SVG drawn as an image cannot run scripts or load anything.
  if (svg) return <img className="nb-image" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt="Figure output" style={size(metadata, 'image/svg+xml')}/>;
  const html = text(data['text/html']), table = html ? htmlTable(html) : null;
  if (table) return <Table head={table.head} body={table.body}/>;
  const markdown = text(data['text/markdown']);
  if (markdown !== undefined) return <Markdown text={markdown}/>;
  const latex = text(data['text/latex']);
  if (latex !== undefined) return <code className="nb-math nb-math-block" title="Formula, shown as written">{latex}</code>;
  const plain = text(data['text/plain']), csv = text(data['text/csv']);
  if (plain !== undefined && !(html && /^<[\w.]+ object(?: at 0x[0-9a-f]+)?>$/u.test(plain.trim()))) return <pre className="nb-text">{plainOutput(plain)}</pre>;
  if (csv !== undefined) return <CsvTable csv={csv}/>;
  const json = Object.keys(data).find(mime => mime === 'application/json' || mime.endsWith('+json'));
  if (json) return <pre className="nb-text">{JSON.stringify(data[json], null, 2)}</pre>;
  return <p className="nb-unsupported">{html ? 'This output is a web page, which ros.ai doesn’t show. It stays in the notebook file.' : `ros.ai can’t show this kind of output (${Object.keys(data).join(', ') || 'empty'}). It stays in the notebook file.`}</p>;
}

/** One output of a code cell, with optional actions such as saving it as a result. */
export function OutputView({ output, actions }: { output: NotebookOutput; actions?: ReactNode }) {
  let body: ReactNode;
  if (output.output_type === 'stream') body = <pre className={`nb-text nb-stream ${output.name}`}>{plainOutput(output.text)}</pre>;
  else if (output.output_type === 'error') {
    const traceback = plainOutput(output.traceback.join('\n')).trim();
    body = <div className="nb-error" role="group" aria-label={`Error: ${output.ename}`}><strong>{output.ename}{output.evalue ? `: ${output.evalue}` : ''}</strong>{traceback && <pre>{traceback}</pre>}</div>;
  } else body = <Rich data={output.data} metadata={output.metadata}/>;
  return <div className={`nb-output ${output.output_type}`}>{body}{actions && <div className="nb-output-actions">{actions}</div>}</div>;
}
