import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { auth, pool } from './auth.js';
import { config } from './config.js';
import { checkCatalogue, gateway } from './gateway.js';
import { devicePage, signInPage } from './pages.js';

/** ros.ai cloud: sign-in and the free hosted Ros, in one small service. The local app stays the
 * product; turning this off leaves every other route in the app working. */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
// Better Auth reads its own request bodies, so it is mounted before any JSON parser.
app.all('/api/auth/*splat', toNodeHandler(auth));
app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
app.get('/health', async (_req, res) => { await pool.query('select 1'); res.json({ ok: true }); });
// Only same-site paths, so the sign-in page cannot be used to send people elsewhere.
const local = (value: unknown) => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/signed-in';
app.get('/sign-in', (req, res) => { res.setHeader('X-Frame-Options', 'DENY'); res.type('html').send(signInPage(local(req.query.next))); });
app.get('/device', (req, res) => { res.setHeader('X-Frame-Options', 'DENY'); res.type('html').send(devicePage(typeof req.query.user_code === 'string' ? req.query.user_code.slice(0, 32) : '')); });
app.get('/signed-in', (_req, res) => { res.type('html').send(signInPage('/signed-in').replace('<h1>Sign in to ros.ai</h1>', '<h1>You are signed in</h1>')); });
app.use(gateway);
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('ros.ai cloud:', error instanceof Error ? error.message : error);
  if (!res.headersSent) res.status(500).json({ error: { message: 'ros.ai cloud had a problem with this request.', type: 'server_error' } });
});

app.listen(config.port, () => { console.log(`ros.ai cloud on ${config.publicUrl} (port ${config.port})`); void checkCatalogue(); });
