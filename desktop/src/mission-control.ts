/**
 * ros.ai's look in Mission Control: while Mission Control is open, the ros.ai window shows the ring over a blurred
 * view of its own workspace, Paper (white) when the Mac is in light mode and Night when it is dark.
 * macOS tells an app nothing when Mission Control opens, so a small script asks the window server a few times a
 * second whether the Dock is showing a full-screen window (Mission Control, App Exposé or Launchpad) and the
 * window covers itself only then. Mission Control's pictures of windows are live, so the cover appears in them.
 * ROS_MISSION_CONTROL_DEBUG=1 prints the Dock's windows on each change, to tune the check on a new macOS.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { BrowserWindow } from 'electron';

// JXA (JavaScript for Automation). Window owners, layers and bounds need no Screen Recording permission.
const WATCH = `
ObjC.import('CoreGraphics'); ObjC.import('AppKit');
const debug = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('ROS_MISSION_CONTROL_DEBUG')) === '1';
const out = $.NSFileHandle.fileHandleWithStandardOutput;
const say = text => out.writeData($(text + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
let last = '';
for (;;) {
  const all = $.NSScreen.screens, screens = [];
  for (let i = 0; i < all.count; i++) screens.push(all.objectAtIndex(i).frame);
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 /* on screen only */, 0))) || [];
  const dock = list.filter(w => w.kCGWindowOwnerName === 'Dock');
  const open = dock.some(w => w.kCGWindowLayer > 0 && screens.some(s =>
    w.kCGWindowBounds.Width >= s.size.width * 0.9 && w.kCGWindowBounds.Height >= s.size.height * 0.9));
  const state = open ? 'open' : 'closed';
  if (state !== last) {
    last = state; say(state);
    if (debug) say('debug ' + JSON.stringify({ screens, dock: dock.map(w => [w.kCGWindowLayer, w.kCGWindowBounds]) }));
  }
  delay(0.12);
}`;

const CSS = `
#ros-mission-control { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; display: none;
  --veil: rgba(255,255,255,.80); --glow: rgba(214,255,60,.28); --halo: none;
  background: radial-gradient(50% 48% at 50% 52%, var(--glow), transparent 70%), var(--veil);
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
@media (prefers-color-scheme: dark) { #ros-mission-control { --veil: rgba(13,16,12,.82); --glow: rgba(122,216,12,.22); --halo: drop-shadow(0 0 28px rgba(122,216,12,.45)); } }
html.ros-mission-control #ros-mission-control { display: block; }
#ros-mission-control::after { content: ""; position: absolute; left: 50%; top: 50%; width: 22vmin; height: 22vmin; transform: translate(-50%, -50%);
  background: url('/brand/ros-ai-ring.png') center / contain no-repeat; filter: var(--halo); }`;

const ADD = `if (!document.getElementById('ros-mission-control')) { const cover = document.createElement('div'); cover.id = 'ros-mission-control'; document.documentElement.append(cover); }`;

/** Covers `main` while Mission Control is open. Stops with the window. */
export function watchMissionControl(main: BrowserWindow) {
  let open = false, stopped = false, restarted = false;
  let watcher: ChildProcess | undefined;
  const show = () => {
    if (main.isDestroyed()) return;
    void main.webContents.executeJavaScript(`${ADD} document.documentElement.classList.toggle('ros-mission-control', ${open})`).catch(() => {});
  };
  main.webContents.on('did-finish-load', () => { void main.webContents.insertCSS(CSS).catch(() => {}); show(); });

  const start = () => {
    watcher = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', WATCH], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buffer = '';
    watcher.stdout?.on('data', chunk => {
      buffer += String(chunk);
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line.startsWith('debug ')) console.log(`Mission Control: ${line.slice(6)}`);
        else if (line === 'open' || line === 'closed') { open = line === 'open'; show(); }
      }
    });
    // A script that dies (a macOS change, a killed process) comes back once after a pause; a second death stays down.
    watcher.on('exit', () => {
      if (stopped) return;
      if (open) { open = false; show(); }
      if (!restarted) { restarted = true; setTimeout(start, 3000); }
    });
  };
  start();
  main.once('closed', () => { stopped = true; watcher?.kill(); });
}
