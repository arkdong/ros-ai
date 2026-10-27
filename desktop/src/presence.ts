/**
 * ros.ai's tile in Mission Control: a small extra window, parked just off the screen's edge and on every desktop,
 * that only ever shows the ring over a faint, blurred picture of the workspace. macOS tells an app nothing when
 * Mission Control opens, but Mission Control shows every open window, so this window is what it finds there.
 * Paper (white) when the Mac is in light mode, Night when it is dark. Clicking the tile brings the real window back.
 */
import { BrowserWindow, nativeTheme, screen } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WIDTH = 720, HEIGHT = 450;

function ringDataUrl(root: string): string {
  for (const file of [join(root, 'dist', 'client', 'brand', 'ros-ai-ring.png'), join(root, 'public', 'brand', 'ros-ai-ring.png')]) {
    if (existsSync(file)) return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  }
  return '';
}

// The page follows the Mac's appearance on its own (prefers-color-scheme tracks nativeTheme).
const page = (ring: string) => `<!doctype html><meta charset="utf-8"><title>ros.ai</title><style>
:root { --ground: #ffffff; --veil: rgba(255,255,255,.80); --glow: rgba(214,255,60,.28); --halo: none; }
@media (prefers-color-scheme: dark) { :root { --ground: #0d100c; --veil: rgba(13,16,12,.80); --glow: rgba(122,216,12,.22); --halo: drop-shadow(0 0 28px rgba(122,216,12,.45)); } }
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--ground); cursor: default; user-select: none; }
#work { position: absolute; inset: -24px; background: center / cover no-repeat; filter: blur(8px); }
#veil { position: absolute; inset: 0; background: radial-gradient(50% 48% at 50% 52%, var(--glow), transparent 70%), var(--veil); }
#ring { position: absolute; left: 50%; top: 50%; width: 30vh; height: 30vh; transform: translate(-50%, -50%); filter: var(--halo); }
</style><div id="work"></div><div id="veil"></div><img id="ring" alt="" src="${ring}">
<script>window.setWork = url => { document.getElementById('work').style.backgroundImage = url ? 'url(' + url + ')' : 'none'; };</script>`;

/** Opens the tile beside `main` and keeps its picture of the workspace fresh. Closes itself with `main`. */
export function openPresence(main: BrowserWindow, root: string) {
  const tile = new BrowserWindow({
    width: WIDTH, height: HEIGHT, show: false, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, hasShadow: false, enableLargerThanScreen: true, title: 'ros.ai',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d100c' : '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  tile.excludedFromShownWindowsMenu = true;
  tile.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false, skipTransformProcessType: true });
  void tile.loadURL(`data:text/html;base64,${Buffer.from(page(ringDataUrl(root))).toString('base64')}`);

  // Just past the right edge of the main display, so it is never on screen but Mission Control still lists it.
  const park = () => {
    if (tile.isDestroyed()) return;
    const { bounds } = screen.getPrimaryDisplay();
    tile.setBounds({ x: bounds.x + bounds.width + 40, y: bounds.y + Math.round((bounds.height - HEIGHT) / 2), width: WIDTH, height: HEIGHT });
  };
  tile.once('ready-to-show', () => { park(); tile.showInactive(); });
  screen.on('display-metrics-changed', park);

  // Picked in Mission Control (or reached with Cmd-`): hand over to the real window.
  tile.on('focus', () => {
    if (main.isDestroyed()) return;
    if (main.isMinimized()) main.restore();
    main.show(); main.focus();
  });

  // A small, recent picture of the workspace, taken while ros.ai is still on screen.
  const snapshot = () => {
    if (main.isDestroyed() || tile.isDestroyed() || !main.isVisible()) return;
    void main.webContents.capturePage().then(image => {
      if (image.isEmpty() || tile.isDestroyed()) return;
      const small = `data:image/jpeg;base64,${image.resize({ width: 480 }).toJPEG(70).toString('base64')}`;
      void tile.webContents.executeJavaScript(`window.setWork(${JSON.stringify(small)})`).catch(() => {});
    }).catch(() => {});
  };
  main.on('blur', snapshot);
  main.on('minimize', snapshot);
  main.webContents.on('did-finish-load', () => setTimeout(snapshot, 1500));

  main.once('closed', () => {
    screen.removeListener('display-metrics-changed', park);
    if (!tile.isDestroyed()) tile.destroy();
  });
  return tile;
}
