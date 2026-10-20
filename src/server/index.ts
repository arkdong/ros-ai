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
import { ToolLoopAgentService } from './tool-loop-agent.js';
import { AssistantService } from './assistant.js';
import { CombinedNebiusBudget } from './combined-budget.js';
import { SandboxBudget } from './sandbox-budget.js';
import { LocalPythonBackend } from './sandbox.js';
import { PythonRuntime, systemConfine } from './local-python.js';
import { createApp, apiErrorHandler } from './app.js';
import { acquireDataLock } from './lock.js';
import { createPublicDemoApp } from './public-demo.js';
import { ToolCredentials } from './tool-credentials.js';
import { PluginTokens } from './plugins.js';
import { RemoteApps } from './remote-apps.js';
import { GoogleDriveConnection } from './google-drive.js';
import { InferenceConnections } from './inference-connections.js';
import { CloudAccount } from './cloud-account.js';
import type { NotebookService } from './notebooks.js';
import type { ProjectFolders } from './project-folders.js';
import { WorkspaceGuideService } from './workspace-guide.js';
import { OutsideAgents } from './outside-agents.js';
import { Setup } from './setup.js';
import { NotionApi } from './notion.js';
import { AgentWorkspaceTools } from './agent-tools.js';
import { applyStartingAllowances, loadLocalKeys } from './local-keys.js';
import { PersonalMemory } from './personal-memory.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const publicMode = process.env.ROS_PUBLIC_DEMO === '1';
if (!publicMode) loadEnv({ path: resolve(root, '.env.local'), quiet: true });
// Keys typed once into a file outside the code, before anything reads them.
let keysFile: string | null = null;
try { keysFile = publicMode ? null : loadLocalKeys(); }
catch (error) { console.error(`ros.ai could not start: ${error instanceof Error ? error.message : error}`); process.exit(1); }
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
let loop:ToolLoopAgentService|undefined;
let cloud:CloudAccount|undefined;
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
    await loop?.shutdown();
    cloud?.shutdown();
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
    publicDemo = createPublicDemoApp({dataDir,origin,landing:resolve(root,'dist/client/landing.html'),maxSessions:Number(process.env.ROS_PUBLIC_MAX_SESSIONS || 500),sessionDays:Number(process.env.ROS_PUBLIC_SESSION_DAYS || 7)});
    app = publicDemo.app;
  } else {
    store = new Store(dataDir);
    const credentials = new ToolCredentials(dataDir);
    googleDrive = new GoogleDriveConnection({dataDir,port});
    const combinedBudget = new CombinedNebiusBudget(store);
    const inference = new InferenceConnections(store,dataDir);
    execution = new ExecutionService(store,{combinedBudget,inference});
    const started = applyStartingAllowances(execution.connectionBudgets, provider => Boolean(store!.globalRecord('connection-allowance', provider)));
    // ros.ai cloud is on by default; ROS_CLOUD_URL points at another one, and ROS_CLOUD_URL=off hides it.
    const cloudUrl=process.env.ROS_CLOUD_URL ?? 'https://cloud-production-8a85.up.railway.app';
    cloud = new CloudAccount(cloudUrl==='off' ? undefined : cloudUrl.replace(/\/+$/u,'') || undefined,dataDir,inference);
    // Code and Notebook blocks run ros.ai's own Python in the OS sandbox where ros.ai has one (macOS), else in Docker.
    const confine = systemConfine(), python = confine ? { runtime: new PythonRuntime(join(dataDir, 'python')), confine } : undefined;
    experiments = new ExperimentService(store,{sandboxBudget:new SandboxBudget(store,{combinedBudget}),...(python?{sandbox:new LocalPythonBackend(python.runtime,python.confine)}:{})});
    research=new ResearchService(store,execution,experiments);
    agent=new CodexAgentService(store,execution,experiments);
    claude=new ClaudeAgentService(store,execution,experiments,dataDir);
    loop=new ToolLoopAgentService(store,execution,experiments);
    const personal=new PersonalMemory(store,dataDir);
    assistant=new AssistantService(store,execution,experiments,agent,claude,loop,personal);
    guide=new WorkspaceGuideService(store,execution);
    outside=new OutsideAgents(store,execution,experiments,assistant,dataDir,root,personal);
    const plugins = new PluginTokens(dataDir);
    AgentWorkspaceTools.notion = new NotionApi(() => plugins.token('notion'));
    const apps = new RemoteApps(dataDir);
    AgentWorkspaceTools.apps = apps;
    const setup = new Setup({dataDir,outside,inference,credentials,plugins,cloud});
    app = createApp(store, execution, experiments,research,assistant,{projectFolders:{reserved:[dataDir,root]},notebooks:{owner:createHash('sha256').update(dataDir).digest('hex').slice(0,16),...(python?{python}:{})},localPaths:{dataDir,keysFile}},agent,{credentials,googleDrive,claude,plugins,apps,outside,cloud,setup,memory:personal},guide);
    if (keysFile) console.log(`  Keys: ${keysFile}${started.length ? ` (starting allowance: ${started.join(', ')})` : ''}`);
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
