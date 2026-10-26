import { existsSync, readFileSync, statSync } from 'node:fs';
import { arch, release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import { z } from 'zod';
import { FEEDBACK_MAX_CHARS, type FeedbackSetup } from '../shared/feedback.js';
import type { CloudAccount } from './cloud-account.js';
import { StoreError } from './store.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const noteSchema = z.object({
  kind: z.enum(['problem', 'idea', 'question']),
  message: z.string().trim().min(1, 'Write a note first.').max(FEEDBACK_MAX_CHARS),
  email: z.email().max(254).optional(),
  details: z.string().trim().max(400).optional(),
}).strict();

/** The checked-out commit, read from .git rather than by running git, which on a Mac without the
 * developer tools asks to install them. Empty for the Mac app, which ships without .git. */
function checkedOutCommit() {
  try {
    let git = join(root, '.git');
    // A worktree (npm run try) has a .git file that points at its own folder.
    if (statSync(git).isFile()) git = resolve(root, readFileSync(git, 'utf8').replace(/^gitdir:/u, '').trim());
    const head = readFileSync(join(git, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 7);
    const ref = head.slice(5), common = existsSync(join(git, 'commondir')) ? resolve(git, readFileSync(join(git, 'commondir'), 'utf8').trim()) : git;
    const sha = existsSync(join(common, ref)) ? readFileSync(join(common, ref), 'utf8').trim()
      : readFileSync(join(common, 'packed-refs'), 'utf8').split('\n').find(line => line.endsWith(` ${ref}`))?.split(' ')[0] ?? '';
    return /^[0-9a-f]{40}$/u.test(sha) ? sha.slice(0, 7) : '';
  } catch { return ''; }
}

function systemName() {
  if (process.platform === 'darwin') {
    try { return `macOS ${/<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/u.exec(readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8'))![1]}`; }
    catch { return `macOS (Darwin ${release()})`; }
  }
  return `${process.platform === 'win32' ? 'Windows' : process.platform === 'linux' ? 'Linux' : process.platform} ${release()}`;
}

let details: string | undefined;
/** The server's half of the app-details line: ros.ai's version and commit, the operating system and
 * Node. Nothing about projects, files, keys or models. */
function appDetails() {
  if (details) return details;
  let version = 'unknown';
  try { version = String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version); } catch { /* still worth sending the rest */ }
  const commit = checkedOutCommit();
  return details = [`ros.ai ${version}${commit ? ` (${commit})` : ''}`, `${systemName()} ${arch()}`, `Node ${process.versions.node}`].join(' · ');
}

/** The feedback card's two calls. Opening the card reads only this computer; a note goes to ros.ai
 * cloud only when the person presses Send. */
export function attachFeedbackRoutes(app: Express, cloud?: CloudAccount) {
  app.get('/api/feedback', (_req, res) => {
    const setup: FeedbackSetup = { cloud: Boolean(cloud?.available), email: cloud?.signedInEmail(), details: appDetails() };
    res.json(setup);
  });
  app.post('/api/feedback', async (req, res) => {
    if (!cloud?.available) throw new StoreError('ros.ai cloud is off in this copy of ros.ai.', 404);
    res.json(await cloud.sendFeedback(noteSchema.parse(req.body)));
  });
}
