export type ResultPageSize = 2 | 4 | 'all';
export type ResultPageChoice = { size: ResultPageSize; page: number };
export function resultPage<T>(items: readonly T[], supplied: unknown) {
  const value = supplied && typeof supplied === 'object' ? supplied as Partial<ResultPageChoice> : {};
  const size: ResultPageSize = value.size === 4 || value.size === 'all' ? value.size : 2;
  const pageCount = size === 'all' ? 1 : Math.max(1, Math.ceil(items.length / size));
  const page = size === 'all' ? 0 : Math.max(0, Math.min(pageCount - 1, Number.isInteger(value.page) ? value.page! : 0));
  const start = size === 'all' ? 0 : page * size;
  return { size, page, pageCount, total: items.length, start, items: size === 'all' ? [...items] : items.slice(start, start + size) };
}
/** Changing density keeps the first visible result in view when possible. */
export function changeResultPageSize(total: number, choice: ResultPageChoice, size: ResultPageSize): ResultPageChoice {
  const current = resultPage(Array.from({ length: total }), choice);
  return { size, page: size === 'all' ? 0 : Math.floor(current.start / size) };
}
