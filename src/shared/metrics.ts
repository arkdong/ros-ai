import type { MetricPoint, MetricRead, MetricSource } from './types.js';

/** The tool a Metrics block reads, by name: its card and block view are headed with it, beside the tool's logo. */
export const METRIC_TOOLS = { github: 'GitHub', cloud: 'ros.ai cloud', umami: 'Umami', railway: 'Railway' } as const satisfies Record<MetricSource, string>;
export type MetricTool = (typeof METRIC_TOOLS)[MetricSource];

const HOUR = 60 * 60_000;
/** "Today" and "this week" compare with a read at least this long before the latest; ros.ai only reads while it is open, so reads are not evenly spaced. */
const DAY_BACK = 20 * HOUR, WEEK_BACK = 6.5 * 24 * HOUR;
/** An App gets every read of the last two days, and before that the last read of each day. */
const ALL_READS = 48 * HOUR;

/** The value the history held about `ago` before `at`, if ros.ai read the source that long ago. */
export function earlierValue(history: readonly MetricPoint[], key: string, at: string, ago: number): number | undefined {
  const until = Date.parse(at) - ago;
  for (let index = history.length - 1; index >= 0; index--) {
    const point = history[index];
    if (Date.parse(point.at) <= until && point.values[key] !== undefined) return point.values[key];
  }
  return undefined;
}

/** How a number moved over about the last day and week; missing where ros.ai has no read that old. */
export function metricChange(read: Pick<MetricRead, 'history' | 'fetchedAt'>, key: string, value: number): { today?: number; week?: number } {
  const day = earlierValue(read.history, key, read.fetchedAt, DAY_BACK), week = earlierValue(read.history, key, read.fetchedAt, WEEK_BACK);
  return { ...(day !== undefined ? { today: value - day } : {}), ...(week !== undefined ? { week: value - week } : {}) };
}

/** What an agent reads for a Metrics block: each number by its key, and how it moved over the last day and week. */
export function metricSummary(read: MetricRead) {
  return {
    source: read.source, title: read.title, link: read.link, readAt: read.fetchedAt, ...(read.notice ? { notice: read.notice } : {}),
    values: read.values.map(item => {
      if (item.text) return { key: item.key, label: item.label, state: item.text };
      if (item.value === null) return { key: item.key, label: item.label, value: null, note: item.note };
      const { today, week } = metricChange(read, item.key, item.value);
      return { key: item.key, label: item.label, value: item.value, ...(today !== undefined ? { changeOverDay: today } : {}), ...(week !== undefined ? { changeOverWeek: week } : {}) };
    }),
  };
}

const METRIC_COLUMNS = ['key', 'label', 'value', 'today', 'week', 'state', 'note'];
/** What an App reads for a Metrics block: one row per number (a service's state, such as a Railway deploy, is text),
 * and the earlier reads for lines over time. */
export function metricTable(read: MetricRead) {
  const rows = read.values.map(item => {
    const change = item.value === null ? {} : metricChange(read, item.key, item.value);
    return { key: item.key, label: item.label, value: item.value, today: change.today ?? null, week: change.week ?? null, state: item.text ?? null, note: item.note ?? null };
  });
  const latest = read.history.at(-1), recent = latest ? Date.parse(latest.at) - ALL_READS : 0, history: MetricPoint[] = [];
  for (const point of read.history) {
    const last = history.at(-1);
    if (Date.parse(point.at) < recent && last && last.at.slice(0, 10) === point.at.slice(0, 10)) history[history.length - 1] = point;
    else history.push(point);
  }
  return { table: { columns: METRIC_COLUMNS, rows, truncated: false }, history };
}
