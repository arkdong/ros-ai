/**
 * ros.ai's look in Mission Control: while Mission Control is open, the ros.ai window shows the ring over a blurred
 * view of its own workspace.
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
  delay(0.08);
}`;

// Only a blur of the window's own content and the ring, so it follows whatever theme the app shows.
// Blur and ring fade together, about as long as Mission Control's own zoom.
const CSS = `
#ros-mission-control { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; opacity: 0;
  -webkit-backdrop-filter: blur(0); backdrop-filter: blur(0);
  transition: opacity .28s ease, backdrop-filter .28s ease, -webkit-backdrop-filter .28s ease; }
html.ros-mission-control #ros-mission-control { opacity: 1; -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); }
#ros-mission-control::after { content: ""; position: absolute; left: 50%; top: 50%; width: 22vmin; height: 22vmin;
  transform: translate(-50%, -50%) scale(.94); transition: transform .28s ease;
  background: url('/brand/ros-ai-ring.png') center / contain no-repeat; }
html.ros-mission-control #ros-mission-control::after { transform: translate(-50%, -50%) scale(1); }
@media (prefers-reduced-motion: reduce) { #ros-mission-control, #ros-mission-control::after { transition: none; } }`;

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
