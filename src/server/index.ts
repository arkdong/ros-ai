import { config as loadEnv } from 'dotenv';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from 'node:http';
import { Store } from './store.js';
import { ExecutionService } from './execution.js';
import { ExperimentService } from './experiments.js';
import { ResearchService } from './research.js';
import { CodexAgentService } from './codex-agent.js';
import { ClaudeAgentService } from './claude-agent.js';
import { AssistantService } from './assistant.js';
import { CombinedNebiusBudget } from './combined-budget.js';
import { SandboxBudget } from './sandbox-budget.js';
import { createApp, apiErrorHandler } from './app.js';
import { acquireDataLock } from './lock.js';
import { createPublicDemoApp } from './public-demo.js';
import { ToolCredentials } from './tool-credentials.js';
import { PluginTokens } from './plugins.js';
import { GoogleDriveConnection } from './google-drive.js';
import { InferenceConnections } from './inference-connections.js';
import type { NotebookService } from './notebooks.js';
import type { ProjectFolders } from './project-folders.js';
import { WorkspaceGuideService } from './workspace-guide.js';
import { OutsideAgents } from './outside-agents.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const publicMode = process.env.ROS_PUBLIC_DEMO === '1';
if (!publicMode) loadEnv({ path: resolve(root, '.env.local'), quiet: true });
// ros.ai's own records live in the usual app-data place, so reinstalling the code keeps them.
// An install that already keeps them next to the code goes on using that folder.
const appData = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'ros.ai')
  : process.platform === 'win32' ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'ros.ai')
  : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'ros.ai');
const dataDir = resolve(process.env.ROS_DATA_DIR || (existsSync(resolve(root, '.ros-ai')) || publicMode ? resolve(root, '.ros-ai') : appData));
const port = Number(process.env.ROS_PORT || (publicMode ? process.env.PORT || 8080 : 4310));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('ROS_PORT must be an integer between 1024 and 65535.');
// Lock before opening Store so concurrent startup cannot recover another process's work.
const releaseLock = acquireDataLock(dataDir);
let store: Store | undefined;
let execution: ExecutionService | undefined;
let experiments: ExperimentService | undefined;
let research:ResearchService|undefined;
let assistant:AssistantService|undefined;
let agent:CodexAgentService|undefined;
let claude:ClaudeAgentService|undefined;
let googleDrive:GoogleDriveConnection|undefined;
let guide:WorkspaceGuideService|undefined;
let outside:OutsideAgents|undefined;
let notebooks:NotebookService|undefined;
let projectFolders:ProjectFolders|undefined;
let publicDemo:ReturnType<typeof createPublicDemoApp>|undefined;
let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
let stopping = false;
const server = createServer();
async function shutdown() {
  if (stopping) return;
  stopping = true;
  // Release the data lock even if one service fails to stop cleanly.
  try {
    projectFolders?.shutdown();
    await notebooks?.shutdown();
    await guide?.shutdown();
    await assistant?.shutdown();
    await agent?.shutdown();
    await claude?.shutdown();
    await execution?.shutdown();
    await experiments?.shutdown();
    await research?.shutdown();
    googleDrive?.shutdown();
    server.close();
    await vite?.close();
    publicDemo?.close();
    store?.close();
  } finally {
    releaseLock();
  }
}
try {
  let app:express.Express;
  if (publicMode) {
    if (process.env.ROS_DEV === '1') throw new Error('Public demo mode serves a production frontend build. Build it first and leave ROS_DEV unset.');
    const origin = process.env.ROS_PUBLIC_ORIGIN || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
    if (!origin) throw new Error('Set ROS_PUBLIC_ORIGIN or RAILWAY_PUBLIC_DOMAIN before starting public demo mode.');
    publicDemo = createPublicDemoApp({dataDir,origin,maxSessions:Number(process.env.ROS_PUBLIC_MAX_SESSIONS || 500),sessionDays:Number(process.env.ROS_PUBLIC_SESSION_DAYS || 7)});
    app = publicDemo.app;
  } else {
    store = new Store(dataDir);
    const credentials = new ToolCredentials(dataDir);
    googleDrive = new GoogleDriveConnection({dataDir,port});
    const combinedBudget = new CombinedNebiusBudget(store);
    execution = new ExecutionService(store,{combinedBudget,inference:new InferenceConnections(store,dataDir)});
    experiments = new ExperimentService(store,{sandboxBudget:new SandboxBudget(store,{combinedBudget})});
    research=new ResearchService(store,execution,experiments);
    agent=new CodexAgentService(store,execution,experiments);
    claude=new ClaudeAgentService(store,execution,experiments,dataDir);
    assistant=new AssistantService(store,execution,experiments,agent,claude);
    guide=new WorkspaceGuideService(store,execution);
    outside=new OutsideAgents(store,execution,experiments,assistant,dataDir,root);
    app = createApp(store, execution, experiments,research,assistant,{projectFolders:{reserved:[dataDir,root]},notebooks:{owner:createHash('sha256').update(dataDir).digest('hex').slice(0,16)}},agent,{credentials,googleDrive,claude,plugins:new PluginTokens(dataDir),outside},guide);
  }
  notebooks=app.locals.notebooks;
  projectFolders=app.locals.projectFolders;
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
    outside?.publish(port);
    console.log(`\n  ros.ai ${publicMode ? 'public demo' : 'local workspace'} is ready on port ${port}\n  Data: ${dataDir}\n  Press Ctrl+C to stop.\n`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void shutdown().catch(error => { console.error(`ros.ai stopped with an error: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; }).finally(() => process.exit()); });
} catch (error) {
  console.error(`ros.ai could not start: ${error instanceof Error ? error.message : 'Unknown error'}`);
  await shutdown();
  process.exitCode = 1;
}
