/** What ros.ai counts each day for ros.ai cloud's launch numbers, and nothing else: numbers only, never names,
 * titles, content, files or addresses (see src/server/usage-counts.ts). */
export const USAGE_KEYS = ['workspaces', 'sources', 'conversations', 'python_runs', 'reports'] as const;
export type UsageKey = typeof USAGE_KEYS[number];
export type UsageCounts = Partial<Record<UsageKey, number>>;
export const USAGE_NAMES: Record<UsageKey, string> = { workspaces: 'Projects', sources: 'Sources', conversations: 'Messages to agents', python_runs: 'Python runs', reports: 'Reports' };
/** What the Settings switch shows: whether counts go to ros.ai cloud, and why they cannot when they cannot. */
export type UsageCountsStatus = { on: boolean; signedIn: boolean; available: boolean; sentAt?: string; today: UsageCounts };
