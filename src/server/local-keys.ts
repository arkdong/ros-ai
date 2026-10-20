import { parse } from 'dotenv';
import { constants, closeSync, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectionBudgetProviders } from '../shared/connection-budgets.js';
import type { ConnectionBudgets } from './connection-budgets.js';

/** Only keys, tokens and starting allowances come from the keys file; it cannot move data folders or ports. */
const ALLOWED = /^(?:[A-Z][A-Z0-9_]*_API_KEY|NOTION_TOKEN|ROS_START_ALLOWANCE_[A-Z]+_(?:USD|REQUESTS))$/u;

/** One owner-only file of API keys outside the code and every data folder, read at each start,
 * so a fresh data folder (an eval run, a pull request copy) does not need the keys typed in again.
 * `ROS_KEYS_FILE` points at another file, and `ROS_KEYS_FILE=off` skips it.
 * Values already in the environment win. Returns the file read, or null. */
export function loadLocalKeys(): string | null {
  const setting = process.env.ROS_KEYS_FILE?.trim();
  if (setting === 'off') return null;
  const file = resolve(setting || join(homedir(), '.config', 'ros.ai', 'keys.env'));
  if (!existsSync(file)) {
    if (setting) throw new Error(`ROS_KEYS_FILE names ${file}, which does not exist.`);
    return null;
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let values: Record<string, string>;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 20000) throw new Error(`The keys file ${file} is not a small plain file.`);
    if ((info.mode & 0o077) !== 0) throw new Error(`The keys file ${file} can be read by other users. Run: chmod 600 "${file}"`);
    values = parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
  const ignored = Object.keys(values).filter(name => !ALLOWED.test(name));
  if (ignored.length) console.warn(`ros.ai ignored ${ignored.join(', ')} in ${file}: it only reads API keys, NOTION_TOKEN and ROS_START_ALLOWANCE_* there.`);
  for (const [name, value] of Object.entries(values)) if (ALLOWED.test(name) && value.trim() && process.env[name] === undefined) process.env[name] = value.trim();
  return file;
}

/** `ROS_START_ALLOWANCE_<CLAUDE|TAVILY|NEBIUS|OPENAI>_USD` (and optional `_REQUESTS`, default 200) saves that
 * spending allowance in a data folder that has never had one, as if it were set on the Budget page.
 * An allowance saved, used or paused before is never changed, so a restart does not top it up. */
export function applyStartingAllowances(budgets: ConnectionBudgets, saved: (provider: string) => boolean): string[] {
  const applied: string[] = [];
  for (const provider of connectionBudgetProviders) {
    const usd = process.env[`ROS_START_ALLOWANCE_${provider.toUpperCase()}_USD`]?.trim();
    if (!usd || saved(provider)) continue;
    const limitUsd = Number(usd), maxRequests = Number(process.env[`ROS_START_ALLOWANCE_${provider.toUpperCase()}_REQUESTS`]?.trim() || 200);
    if (!Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > 1000 || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 10000) throw new Error(`ROS_START_ALLOWANCE_${provider.toUpperCase()} needs a USD amount above 0 and at most 1000, and whole requests from 1 to 10000.`);
    budgets.save(provider, { limitUsd, maxRequests, enabled: true, acknowledged: true });
    applied.push(`${provider} US$${limitUsd} / ${maxRequests} requests`);
  }
  return applied;
}
