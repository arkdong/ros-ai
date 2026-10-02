/** A captured table is immutable. These operations either describe a view or a
 * deliberately saved, bounded derived copy; they never access source files. */
export type TableData = { columns: string[]; rows: string[][] };
export type DataTransform = { trim: boolean; dropEmptyRows: boolean; deduplicate: boolean; dropMissing: string[]; search: string; filterColumn: number | null; filter: string; sortColumn: number | null; descending: boolean };
export const emptyTransform: DataTransform = { trim: false, dropEmptyRows: false, deduplicate: false, dropMissing: [], search: '', filterColumn: null, filter: '', sortColumn: null, descending: false };
export function parseCsv(csv: string, strict = false): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  csv = csv.replace(/^\uFEFF/u, '');
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') { if (quoted && csv[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (ch === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (ch === '\n' && !quoted) { row.push(cell.replace(/\r$/u, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (quoted && strict) throw new Error('CSV contains an unclosed quoted field.');
  if (cell || row.length) { row.push(cell.replace(/\r$/u, '')); rows.push(row); }
  return rows;
}
export function fromRows(rows: unknown[][]): TableData {
  const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  return { columns: Array.from({ length: width }, (_, index) => String(rows[0]?.[index] ?? `Column ${index + 1}`)), rows: rows.slice(1).map(row => Array.from({ length: width }, (_, index) => String(row[index] ?? ''))) };
}
export function artifactTable(content: string, csv = true): TableData {
  if (csv) return fromRows(parseCsv(content,true));
  const value: unknown = JSON.parse(content);
  if (!Array.isArray(value)) throw new Error('This saved table is not a supported row array.');
  if (!value.length) return { columns: [], rows: [] };
  if (Array.isArray(value[0])) return fromRows(value);
  if (!value.every(row => row !== null && typeof row === 'object' && !Array.isArray(row))) throw new Error('This saved table does not contain object rows. Open its exact captured text.');
  const columns = [...new Set(value.flatMap(row => row && typeof row === 'object' ? Object.keys(row) : []))];
  return { columns, rows: value.map(row => columns.map(column => { const cell = row?.[column]; return cell === null || cell === undefined ? '' : typeof cell === 'object' ? JSON.stringify(cell) : String(cell); })) };
}
export const missing = (cell: string) => !cell.trim();
export function columnSummary(data: TableData) {
  return data.columns.map((name, index) => {
    const values = data.rows.map(row => row[index] ?? ''), present = values.filter(value => !missing(value));
    const type = !present.length ? 'empty' : present.every(value => /^(true|false)$/iu.test(value)) ? 'boolean' : present.every(value => /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/iu.test(value.trim()) && Number.isFinite(Number(value))) ? 'number' : present.every(value => /^\d{4}-\d{2}-\d{2}(T.*)?$/u.test(value) && !Number.isNaN(Date.parse(value))) ? 'date' : 'text';
    return { name, index, type, missing: values.length - present.length };
  });
}
export function transformTable(data: TableData, operation: DataTransform): TableData {
  let rows = data.rows.map(row => row.map(cell => operation.trim ? cell.trim() : cell));
  if (operation.dropEmptyRows) rows = rows.filter(row => row.some(cell => !missing(cell)));
  const required = operation.dropMissing.map(name => data.columns.indexOf(name)).filter(index => index >= 0);
  if (required.length) rows = rows.filter(row => required.every(index => !missing(row[index] ?? '')));
  if (operation.deduplicate) { const seen = new Set<string>(); rows = rows.filter(row => { const key = JSON.stringify(row); if (seen.has(key)) return false; seen.add(key); return true; }); }
  const search = operation.search.toLocaleLowerCase(), filter = operation.filter.toLocaleLowerCase();
  if (search) rows = rows.filter(row => row.some(cell => cell.toLocaleLowerCase().includes(search)));
  if (filter && operation.filterColumn !== null) rows = rows.filter(row => (row[operation.filterColumn!] ?? '').toLocaleLowerCase().includes(filter));
  if (operation.sortColumn !== null) {
    const index = operation.sortColumn, numeric = columnSummary(data)[index]?.type === 'number';
    rows = rows.map((row, original) => ({ row, original })).sort((a, b) => {
      const left = a.row[index] ?? '', right = b.row[index] ?? '';
      const comparison = missing(left) !== missing(right) ? missing(left) ? 1 : -1 : numeric && !missing(left) ? Number(left) - Number(right) : left.localeCompare(right, undefined, { numeric: true });
      return (operation.descending ? -comparison : comparison) || a.original - b.original;
    }).map(item => item.row);
  }
  return { columns: [...data.columns], rows };
}
export function tableCsv(data: TableData): string {
  const quote = (value: string) => /[",\n\r]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return [data.columns, ...data.rows].map(row => row.map(quote).join(',')).join('\n') + '\n';
}
