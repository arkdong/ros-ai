/**
 * ros.ai's look in Mission Control: while Mission Control is open, the ros.ai window shows the ring over a blurred
 * view of its own workspace.
 * macOS tells an app nothing when Mission Control opens, so a small script asks the window server a few times a
 * second whether the Dock has a window over a whole screen between the app windows and the Dock itself. Mission
 * Control and App Exposé add one there (layer 18 on macOS 26); the Dock's own window spans the screen too but sits
 * at the Dock's level (20) and is on screen whenever the Dock shows, so a Dock sliding in doesn't count. The window
 * covers itself only then. Mission Control's pictures of windows are live, so the cover appears in them.
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
let last = '', note = '', dock = -1, looked = 0;
for (;;) {
  // The Dock by its bundle id, as its window owner name is translated (程序坞 in Chinese); a restarted Dock has a new pid.
  if (Date.now() - looked > 5000) {
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.dock');
    dock = apps.count ? Number(apps.objectAtIndex(0).processIdentifier) : -1;
    looked = Date.now();
  }
  const all = $.NSScreen.screens, screens = [];
  for (let i = 0; i < all.count; i++) screens.push(all.objectAtIndex(i).frame);
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 /* on screen only */, 0))) || [];
  const windows = list.filter(w => (w.kCGWindowOwnerPID === dock || w.kCGWindowOwnerName === 'Dock') && w.kCGWindowLayer > 0);
  const open = windows.some(w => w.kCGWindowLayer < 20 /* the Dock's own level */ && screens.some(s =>
    w.kCGWindowBounds.Width >= s.size.width * 0.9 && w.kCGWindowBounds.Height >= s.size.height * 0.9));
  const state = open ? 'open' : 'closed';
  if (state !== last) { last = state; say(state); }
  if (debug) {
    const seen = windows.map(w => [w.kCGWindowNumber, w.kCGWindowLayer, w.kCGWindowBounds]), now = JSON.stringify(seen);
    if (now !== note) { note = now; say('debug ' + JSON.stringify({ state, screens, dock: seen })); }
  }
  delay(0.08);
}`;

// Only a blur of the window's own content and the ring, so it follows whatever theme the app shows.
// Blur and ring fade in about as long as Mission Control's own zoom, and out faster, so ros.ai is back at once.
const CSS = `
#ros-mission-control { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; opacity: 0;
  -webkit-backdrop-filter: blur(0); backdrop-filter: blur(0);
  transition: opacity .12s ease-out, backdrop-filter .12s ease-out, -webkit-backdrop-filter .12s ease-out; }
html.ros-mission-control #ros-mission-control { opacity: 1; -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
  transition: opacity .28s ease, backdrop-filter .28s ease, -webkit-backdrop-filter .28s ease; }
#ros-mission-control::after { content: ""; position: absolute; left: 50%; top: 50%; width: 22vmin; height: 22vmin;
  transform: translate(-50%, -50%) scale(.94); transition: transform .12s ease-out;
  background: url('/brand/ros-ai-ring.png') center / contain no-repeat; }
html.ros-mission-control #ros-mission-control::after { transform: translate(-50%, -50%) scale(1); transition: transform .28s ease; }
@media (prefers-reduced-motion: reduce) { #ros-mission-control, #ros-mission-control::after, html.ros-mission-control #ros-mission-control, html.ros-mission-control #ros-mission-control::after { transition: none; } }`;

const ADD = `if (!document.getElementById('ros-mission-control')) { const cover = document.createElement('div'); cover.id = 'ros-mission-control'; document.documentElement.append(cover); }`;

/** Covers `main` while Mission Control is open. Stops with the window. */
export function watchMissionControl(main: BrowserWindow) {
  // `held`: ros.ai was picked in Mission Control, so the cover is already gone; skip `open` until the Dock closes.
  let open = false, held = false, stopped = false, restarted = false;
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
        else if (line === 'closed') { held = false; if (open) { open = false; show(); } }
        else if (line === 'open' && !held && !open) { open = true; show(); }
      }
    });
    // A script that dies (a macOS change, a killed process) comes back once after a pause; a second death stays down.
    watcher.on('exit', () => {
      if (stopped) return;
      if (open) { open = false; show(); }
      if (!restarted) { restarted = true; setTimeout(start, 3000); }
    });
  };
  // Picking ros.ai focuses it as Mission Control starts to zoom out, well before the Dock's windows go.
  main.on('focus', () => { if (open) { open = false; held = true; show(); } });
  start();
  main.once('closed', () => { stopped = true; watcher?.kill(); });
}
