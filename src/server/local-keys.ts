import { parse } from 'dotenv';
import { constants, closeSync, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { openToOthers } from './private-file.js';

/** Only keys and tokens come from the keys file; it cannot move data folders or ports. */
const ALLOWED = /^(?:[A-Z][A-Z0-9_]*_API_KEY|NOTION_TOKEN)$/u;

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
    if (openToOthers(info.mode)) throw new Error(`The keys file ${file} can be read by other users. Run: chmod 600 "${file}"`);
    values = parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
  const ignored = Object.keys(values).filter(name => !ALLOWED.test(name));
  if (ignored.length) console.warn(`ros.ai ignored ${ignored.join(', ')} in ${file}: it only reads API keys and NOTION_TOKEN there.`);
  for (const [name, value] of Object.entries(values)) if (ALLOWED.test(name) && value.trim() && process.env[name] === undefined) process.env[name] = value.trim();
  return file;
}
