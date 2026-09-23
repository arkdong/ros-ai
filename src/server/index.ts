import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from 'node:http';
import { Store } from './store.js';
import { ExecutionService } from './execution.js';
import { ExperimentService } from './experiments.js';
import { ResearchService } from './research.js';
import { AssistantService } from './assistant.js';
import { CombinedNebiusBudget } from './combined-budget.js';
import { SandboxBudget } from './sandbox-budget.js';
import { createApp, apiErrorHandler } from './app.js';
import { acquireDataLock } from './lock.js';
import { createPublicDemoApp } from './public-demo.js';
import { Waitlist } from './waitlist.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const publicMode = process.env.ROS_PUBLIC_DEMO === '1';
if (!publicMode) loadEnv({ path: resolve(root, '.env.local'), quiet: true });
const dataDir = resolve(process.env.ROS_DATA_DIR || resolve(root, '.ros-ai'));
const port = Number(process.env.ROS_PORT || (publicMode ? process.env.PORT || 8080 : 4310));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('ROS_PORT must be an integer between 1024 and 65535.');
// Lock before opening Store so concurrent startup cannot recover another process's work.
const releaseLock = acquireDataLock(dataDir);
let store: Store | undefined;
let execution: ExecutionService | undefined;
let experiments: ExperimentService | undefined;
let research:ResearchService|undefined;
let assistant:AssistantService|undefined;
let publicDemo:ReturnType<typeof createPublicDemoApp>|undefined;
let waitlist:Waitlist|undefined;
let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
let stopping = false;
const server = createServer();
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await assistant?.shutdown();
  await execution?.shutdown();
  await experiments?.shutdown();
  await research?.shutdown();
  server.close();
  await vite?.close();
  publicDemo?.close();
  waitlist?.close();
  store?.close();
  releaseLock();
}
try {
  waitlist = new Waitlist(dataDir);
  let app:express.Express;
  if (publicMode) {
    if (process.env.ROS_DEV === '1') throw new Error('Public demo mode serves a production frontend build. Build it first and leave ROS_DEV unset.');
    const origin = process.env.ROS_PUBLIC_ORIGIN || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
    if (!origin) throw new Error('Set ROS_PUBLIC_ORIGIN or RAILWAY_PUBLIC_DOMAIN before starting public demo mode.');
    publicDemo = createPublicDemoApp({dataDir,origin,maxSessions:Number(process.env.ROS_PUBLIC_MAX_SESSIONS || 500),waitlist});
    app = publicDemo.app;
  } else {
    store = new Store(dataDir);
    const combinedBudget = new CombinedNebiusBudget(store);
    execution = new ExecutionService(store,{combinedBudget});
    experiments = new ExperimentService(store,{sandboxBudget:new SandboxBudget(store,{combinedBudget})});
    research=new ResearchService(store,execution,experiments);
    assistant=new AssistantService(store,execution,experiments);
    app = createApp(store, execution, experiments,research,assistant,{waitlist});
  }
  if (process.env.ROS_DEV !== '1') {
    if (!existsSync(resolve(root, 'dist/client/index.html'))) {
      console.log('Building the browser interface for first launch…');
      const { build } = await import('vite');
      await build({ root });
    }
    app.use(express.static(resolve(root, 'dist/client')));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(root, 'dist/client/index.html')));
  } else {
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { server }, host: '127.0.0.1', allowedHosts: ['localhost', '127.0.0.1'] }, appType: 'spa' });
    app.use(vite.middlewares);
  }
  app.use(apiErrorHandler);
  server.on('request', app);
  server.on('error', async (error) => { console.error(`ros.ai could not start: ${error.message}`); await shutdown(); process.exitCode = 1; });
  server.listen(port, publicMode ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(`\n  ros.ai ${publicMode ? 'public demo' : 'local workspace'} is ready on port ${port}\n  Data: ${dataDir}\n  Press Ctrl+C to stop.\n`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void shutdown().then(() => process.exit(0)); });
} catch (error) {
  console.error(`ros.ai could not start: ${error instanceof Error ? error.message : 'Unknown error'}`);
  await shutdown();
  process.exitCode = 1;
}
