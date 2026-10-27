/** SQL over a project's data with DuckDB: every Data block is a table, and the CSV, Parquet and Excel files
 * in the project folder that are not blocks are tables too. Queries only read; a result can be saved as a new Data block. */
export type SqlFormat = 'csv' | 'parquet' | 'excel';
/** columns is null for an Excel file until DuckDB's Excel reader is on this computer. */
export type SqlTable = { name: string; title: string; source: 'block' | 'file'; format: SqlFormat; nodeId?: string; path?: string; columns: string[] | null };
export type SqlTables = { tables: SqlTable[]; folder: boolean };
export type SqlResult = { columns: string[]; types: string[]; rows: string[][]; truncated: boolean; ms: number };
/** The rows a query shows; saving a result keeps all of it, up to the size of a Data block. */
export const SQL_ROWS_SHOWN = 1000;
