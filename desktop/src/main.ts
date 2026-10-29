/**
 * The window side of the ros.ai Mac app. Everything else is the ordinary ros.ai server (dist/server/index.mjs),
 * started here as a child process on Electron's own Node, so a person needs nothing installed:
 *   pick a free port from 4310 → start the server → wait for /api/health → open one window on it.
 * Outside links open in the default browser; closing the window stops the server. Logs live in the data folder.
 * Updates: the server finds, downloads and checks a new ros.ai.app (src/server/updates.ts); this side swaps it in
 * after quitting and opens it again.
 */
import { app, BrowserWindow, dialog, Menu, nativeImage, screen, shell, type MenuItemConstructorOptions } from 'electron';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { UpdateInstallMessage } from '../../src/shared/updates';
import { watchMissionControl } from './mission-control';

// dist/desktop/main.cjs → the repository root (a checkout) or the app folder inside ros.ai.app.
const root = resolve(__dirname, '..', '..');
const version = (() => { try { return String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version); } catch { return '0.0.0'; } })();
const mac = process.platform === 'darwin', windows = process.platform === 'win32';
// The same data folder src/server/index.ts picks, so the app and `npm start` share projects on a plain install.
const appData = mac ? join(homedir(), 'Library', 'Application Support', 'ros.ai')
  : windows ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'ros.ai')
  : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'ros.ai');
const dataDir = resolve(process.env.ROS_DATA_DIR || (existsSync(join(root, '.ros-ai')) ? join(root, '.ros-ai') : appData));
// Electron's own files (cache, window state) stay out of ros.ai's records.
const desktopDir = join(appData, 'desktop');
app.setPath('userData', desktopDir);
app.setName('ros.ai');

let window: BrowserWindow | undefined;
let server: ChildProcess | undefined;
let serverExited = false;
let url = '';
const logDir = join(desktopDir, 'logs'), logFile = join(logDir, 'server.log');
// A packaged Mac app updates itself: the server downloads into updatesDir, this side replaces the bundle.
const bundle = mac && app.isPackaged ? resolve(app.getPath('exe'), '..', '..', '..') : undefined;
const updatesDir = join(desktopDir, 'updates');

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });

/** A Finder-launched app sees a short PATH; the login shell's PATH is where docker, uv, claude and codex are. */
function shellPath(): string | undefined {
  if (windows) return undefined;
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const result = spawnSync(shell, ['-ilc', 'printf "__ROS_PATH__%s__END__" "$PATH"'], { encoding: 'utf8', timeout: 6000, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } });
    const found = /__ROS_PATH__(.*?)__END__/su.exec(`${result.stdout ?? ''}`)?.[1]?.trim();
    if (!found) return undefined;
    const merged = new Set([...found.split(':'), ...(process.env.PATH ?? '').split(':')].filter(Boolean));
    return [...merged].join(':');
  } catch { return undefined; }
}

const free = (port: number) => new Promise<boolean>(done => {
  const probe = createServer();
  probe.once('error', () => done(false));
  probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
});
async function freePort(): Promise<number> {
  const first = Number(process.env.ROS_PORT) || 4310;
  for (let port = first; port <= first + 20; port++) if (await free(port)) return port;
  throw new Error(`No free port between ${first} and ${first + 20}.`);
}

/** A tiny launcher that runs this app's Node, so agents can reach ros.ai over MCP without a separate Node install. */
function nodeLauncher(): string {
  mkdirSync(desktopDir, { recursive: true });
  const file = join(desktopDir, windows ? 'ros-ai-node.cmd' : 'ros-ai-node');
  const body = windows
    ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`
    : `#!/bin/sh\n# Runs the Node inside the ros.ai app. Written by ros.ai at each start.\nexport ELECTRON_RUN_AS_NODE=1\nexec "${process.execPath}" "$@"\n`;
  writeFileSync(file, body);
  if (!windows) chmodSync(file, 0o755);
  return file;
}

function tail(file: string, lines = 12): string {
  try { return readFileSync(file, 'utf8').trim().split('\n').slice(-lines).join('\n'); } catch { return ''; }
}

async function startServer(): Promise<string> {
  const entry = join(root, 'dist', 'server', 'index.mjs');
  if (!existsSync(entry)) throw new Error(`The server bundle is missing (${entry}). Run \`npm run app\` from the checkout to build it.`);
  const port = await freePort();
  mkdirSync(logDir, { recursive: true });
  if (existsSync(logFile)) renameSync(logFile, join(logDir, 'server.previous.log'));
  const log = openSync(logFile, 'a');
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ROS_PORT: String(port), ROS_DESKTOP: '1', ROS_NODE_COMMAND: nodeLauncher() };
  if (process.env.ROS_DATA_DIR === undefined && dataDir !== appData) env.ROS_DATA_DIR = dataDir;
  const path = shellPath();
  if (path) env.PATH = path;
  if (bundle?.endsWith('.app')) { mkdirSync(updatesDir, { recursive: true }); env.ROS_APP_BUNDLE = bundle; env.ROS_APP_UPDATES = updatesDir; }
  server = spawn(process.execPath, [entry], { cwd: root, env, stdio: ['ignore', log, log, 'ipc'] });
  server.on('exit', () => { serverExited = true; });
  server.on('message', installUpdate);
  const health = `http://127.0.0.1:${port}/api/health`;
  for (const deadline = Date.now() + 120_000; ; await new Promise(done => setTimeout(done, 250))) {
    if (serverExited) throw new Error(`ros.ai stopped before it was ready.\n\n${tail(logFile)}`);
    if (Date.now() > deadline) throw new Error(`ros.ai did not start within two minutes.\n\n${tail(logFile)}`);
    try { if ((await fetch(health)).ok) break; } catch { /* not yet */ }
  }
  return `http://127.0.0.1:${port}/`;
}

function stopServer(): Promise<void> {
  return new Promise(done => {
    if (!server || serverExited) return done();
    const timer = setTimeout(() => { server?.kill('SIGKILL'); done(); }, 5000);
    server.once('exit', () => { clearTimeout(timer); done(); });
    server.kill('SIGTERM');
  });
}

// Runs after ros.ai has quit (and so stopped its server): replace the bundle, keep the old one if that fails, open
// whichever is there. A failure leaves a note the server shows on the next start.
const SWAP = `pid=$1 app=$2 next=$3 failed=$4
old="$(dirname "$app")/.ros.ai-replaced.app"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 300 ]; then echo "ros.ai did not quit in time, so it was not updated. Try again." > "$failed"; exit 1; fi
  sleep 0.2
done
rm -rf "$old"
if mv "$app" "$old"; then
  if mv "$next" "$app"; then rm -rf "$old"; else mv "$old" "$app"; echo "ros.ai could not replace itself in $(dirname "$app"). Download the new version from GitHub instead." > "$failed"; fi
else
  echo "ros.ai could not replace itself in $(dirname "$app"). Download the new version from GitHub instead." > "$failed"
fi
open "$app"`;
/** The server says a checked download is ready and the person chose Restart to update. */
function installUpdate(message: unknown) {
  const { type, version: next, app: update } = (message ?? {}) as Partial<UpdateInstallMessage>;
  if (type !== 'ros-update-install' || !bundle || typeof next !== 'string' || !/^\d+\.\d+\.\d+$/u.test(next) || typeof update !== 'string') return;
  // Only an app the server unpacked into its own updates folder (<updates>/<version>/ros.ai.app).
  const target = resolve(update);
  if (dirname(dirname(target)) !== updatesDir || !target.endsWith('.app')) return;
  spawn('/bin/sh', ['-c', SWAP, 'ros-ai-update', String(process.pid), bundle, target, join(updatesDir, 'failed')], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

const local = (target: string) => { try { const { hostname } = new URL(target); return hostname === '127.0.0.1' || hostname === 'localhost'; } catch { return false; } };
const origin = (target: string) => { try { return new URL(target).origin; } catch { return ''; } };
/** An App block's page: ros.ai serves it on a second local port, never the window's own (src/server/app-frames.ts). */
const appPage = (target: string | undefined) => { try { const page = new URL(target ?? ''); return local(page.href) && page.port !== new URL(url).port && /^\/app\/[A-Za-z0-9_-]{32}$/u.test(page.pathname); } catch { return false; } };
/** App pages are written by agents and run in a sealed frame: Chromium's sandbox and the page's own policy keep them
 * off the network and away from ros.ai. The app also stops what a browser tab cannot: an App frame navigating itself
 * to another address, and any request from inside one other than to its own page server. App frames get no
 * permissions, and WebRTC sends nothing over UDP outside a proxy. */
function sealAppFrames(contents: Electron.WebContents) {
  const own = new URL(url).origin;
  // A frame that is gone has no address; reading it throws.
  const address = (frame: Electron.WebFrameMain | null | undefined) => { try { return frame?.url; } catch { return undefined; } };
  // ros.ai gives an App frame its address once; any later navigation of that frame, away or a reload, is the page's own.
  contents.on('will-frame-navigate', event => { if (!event.isMainFrame && appPage(address(event.frame))) event.preventDefault(); });
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    const from = address(details.frame);
    if (!appPage(from)) return callback({});
    let leaves = details.resourceType === 'subFrame';
    try { const target = new URL(details.url); leaves ||= !['data:', 'blob:'].includes(target.protocol) && target.origin !== new URL(from!).origin; } catch { leaves = true; }
    callback({ cancel: leaves });
  });
  // The window's own page keeps every permission it had; any other frame (an App's has an opaque origin) gets none.
  contents.session.setPermissionRequestHandler((_contents, _permission, callback, details) => callback(details.isMainFrame || (!appPage(details.requestingUrl) && origin(details.requestingUrl) === own)));
  contents.session.setPermissionCheckHandler((_contents, _permission, requesting, details) => details.isMainFrame || requesting === own);
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
}
const stateFile = join(desktopDir, 'window.json');
function savedBounds(): Electron.Rectangle | undefined {
  try {
    const bounds = JSON.parse(readFileSync(stateFile, 'utf8')) as Electron.Rectangle;
    const area = screen.getDisplayMatching(bounds).workArea;
    const visible = bounds.x < area.x + area.width && bounds.x + bounds.width > area.x && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
    return visible && bounds.width >= 600 && bounds.height >= 400 ? bounds : undefined;
  } catch { return undefined; }
}

/** ros.ai's windows show ros.ai only; every other address opens in the default browser, also when a ros.ai address
 * redirects there (Sign in opens /api/cloud/start, which goes on to the ros.ai cloud sign-in page) and in the windows
 * ros.ai's page opens itself. A window opened only to go elsewhere closes again instead of staying blank. */
function showOnlyRosAi(contents: Electron.WebContents, closeIfEmpty: boolean) {
  let shown = false;
  contents.on('did-navigate', (_event, address) => { if (local(address)) shown = true; });
  const elsewhere = (event: Electron.Event<{ url: string; isMainFrame: boolean }>) => {
    if (!event.isMainFrame || local(event.url)) return;
    event.preventDefault();
    void shell.openExternal(event.url);
    if (closeIfEmpty && !shown) setImmediate(() => BrowserWindow.fromWebContents(contents)?.close());
  };
  contents.on('will-navigate', elsewhere);
  contents.on('will-redirect', elsewhere);
  contents.setWindowOpenHandler(({ url: target }) => { if (local(target)) return { action: 'allow' }; void shell.openExternal(target); return { action: 'deny' }; });
  contents.on('did-create-window', child => showOnlyRosAi(child.webContents, true));
}

function openWindow() {
  const bounds = savedBounds();
  window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 880, minHeight: 560, ...bounds, title: 'ros.ai', show: false, backgroundColor: '#ffffff',
    // No system title bar: the window buttons sit in ros.ai's own 36px strip (src/client/mac-app.css).
    ...(mac ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 16, y: 12 } } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  window.webContents.setUserAgent(`${window.webContents.getUserAgent()} ros.ai/${version}`);
  sealAppFrames(window.webContents);
  window.once('ready-to-show', () => window?.show());
  // Full screen hides the window buttons, so the page drops the room it keeps for them.
  const fullScreen = (on: boolean) => void window?.webContents.executeJavaScript(`document.documentElement.toggleAttribute('data-full-screen', ${on})`).catch(() => {});
  window.on('enter-full-screen', () => fullScreen(true));
  window.on('leave-full-screen', () => fullScreen(false));
  window.webContents.on('did-finish-load', () => fullScreen(Boolean(window?.isFullScreen())));
  showOnlyRosAi(window.webContents, false);
  window.on('close', () => { try { if (window && !window.isMinimized() && !window.isFullScreen()) writeFileSync(stateFile, JSON.stringify(window.getBounds())); } catch { /* a saved size is a convenience */ } });
  window.on('closed', () => { window = undefined; });
  // A headless check (ROS_DESKTOP_SMOKE=<file.png>): save a picture of the loaded page, then quit.
  const smoke = process.env.ROS_DESKTOP_SMOKE;
  if (smoke) window.webContents.once('did-finish-load', () => setTimeout(() => void window?.webContents.capturePage().then(image => { writeFileSync(smoke, image.toPNG()); console.log(`ros.ai window loaded ${url}; picture saved to ${smoke}`); app.quit(); }), 2500));
  void window.loadURL(url);
  // ros.ai's look in Mission Control (desktop/src/mission-control.ts).
  if (mac && !smoke) watchMissionControl(window);
}

/** Settings › General shows the Updates section and looks again. */
function checkForUpdates() {
  if (!window) return;
  window.show(); window.focus();
  void window.webContents.executeJavaScript(`window.dispatchEvent(new Event('ros-check-updates'))`);
}

function menu() {
  const help: MenuItemConstructorOptions[] = [
    ...(mac ? [] : [{ label: 'Check for updates', click: checkForUpdates }, { type: 'separator' as const }]),
    { label: 'Open in browser', click: () => void shell.openExternal(url) },
    { label: 'Show data folder', click: () => void shell.openPath(dataDir) },
    { label: 'Show logs', click: () => shell.showItemInFolder(logFile) },
    { type: 'separator' },
    { label: 'ros-ai.io', click: () => void shell.openExternal('https://ros-ai.io') },
    { label: 'Source on GitHub', click: () => void shell.openExternal('https://github.com/arkdong/ros-ai') },
  ];
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ label: app.name, submenu: [
      { role: 'about' }, { label: 'Check for Updates…', click: checkForUpdates }, { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] as MenuItemConstructorOptions[] }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: help },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setAboutPanelOptions({ applicationName: 'ros.ai', applicationVersion: version, website: 'https://ros-ai.io', copyright: 'MIT licence. The ros.ai name and logo are excluded.' });
app.whenReady().then(async () => {
  if (mac && !app.isPackaged) { const icon = nativeImage.createFromPath(join(root, 'desktop', 'build', 'icon.png')); if (!icon.isEmpty()) app.dock?.setIcon(icon); }
  menu();
  try { url = await startServer(); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const choice = dialog.showMessageBoxSync({ type: 'error', title: 'ros.ai could not start', message: 'ros.ai could not start', detail: message, buttons: ['Show logs', 'Quit'], defaultId: 1, cancelId: 1 });
    if (choice === 0) shell.showItemInFolder(logFile);
    app.exit(1);
    return;
  }
  openWindow();
  app.on('activate', () => { if (!window && url) openWindow(); });
});
// The app is the workspace: closing its window stops the server, on every platform.
app.on('window-all-closed', () => app.quit());
let stopping = false;
app.on('will-quit', event => {
  if (stopping || !server || serverExited) return;
  stopping = true;
  event.preventDefault();
  void stopServer().then(() => app.quit());
});
