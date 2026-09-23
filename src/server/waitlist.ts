import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express, { type Express, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import type { WaitlistCount, WaitlistJoined } from '../shared/waitlist.js';

const submission = z.object({ email: z.string().trim().toLowerCase().max(254).email() }).strict();

/** One shared list per installation, independent of public visitor workspaces. */
export class Waitlist {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, 'waitlist.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS waitlist_signups (
        email TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
    `);
  }

  count(): WaitlistCount {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM waitlist_signups').get()!;
    return { count: Number(row.count) };
  }

  join(email: string): WaitlistJoined {
    // SQLite's unique key makes repeated/concurrent submissions idempotent.
    this.db.prepare('INSERT INTO waitlist_signups (email, created_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING')
      .run(email.trim().toLowerCase(), new Date().toISOString());
    return { ...this.count(), joined: true };
  }

  close(): void { this.db.close(); }
}

/** Attach after the app's host/origin boundary and before its API catch-all. */
export function attachWaitlistRoutes(app: Express, waitlist: Waitlist, options: { origin?: string } = {}): void {
  const router = express.Router();
  const cookieName = 'ros_ai_waitlist';
  const windowMs = 10 * 60 * 1000;
  const attempts = new Map<string, { count: number; expiresAt: number }>();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/', (_req, res) => res.json(waitlist.count()));
  router.post('/', (req, res, next) => {
    const origin = options.origin ?? `http://${req.headers.host}`;
    if (req.headers.origin !== origin || !req.is('application/json')) {
      res.status(403).json({ error: 'Sign up from this website using a JSON request.' });
      return;
    }
    // A small browser-level burst limit avoids penalizing a whole pitch venue
    // sharing one IP address. This is not identity or email verification.
    const now = Date.now();
    for (const [key, value] of attempts) if (value.expiresAt <= now) attempts.delete(key);
    let browser = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!browser || !attempts.has(browser)) {
      browser = randomBytes(24).toString('hex');
      if (attempts.size >= 5000) attempts.delete(attempts.keys().next().value!);
      attempts.set(browser, { count: 0, expiresAt: now + windowMs });
      res.cookie(cookieName, browser, { httpOnly: true, sameSite: 'strict', secure: origin.startsWith('https:'), path: '/api/waitlist', maxAge: windowMs });
    }
    const attempt = attempts.get(browser)!;
    if (attempt.count >= 5) {
      res.setHeader('Retry-After', String(Math.ceil((attempt.expiresAt - now) / 1000)));
      res.status(429).json({ error: 'Please wait a few minutes before submitting again.' });
      return;
    }
    attempt.count += 1;
    next();
  }, express.json({ limit: '2kb' }), (req, res) => {
    const parsed = submission.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Enter a valid email address.' });
      return;
    }
    res.json(waitlist.join(parsed.data.email));
  });
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const invalidBody = error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large';
    res.status(invalidBody ? error.type === 'entity.too.large' ? 413 : 400 : 503)
      .json({ error: invalidBody ? 'Submit a small JSON request containing your email address.' : 'The waitlist is temporarily unavailable. Please try again.' });
  };
  router.use(errorHandler);
  app.use('/api/waitlist', router);
}
