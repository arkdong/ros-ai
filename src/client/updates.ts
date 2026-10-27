import { useSyncExternalStore } from 'react';
import type { UpdateStatus } from '../shared/updates';
import { api, post } from './api';

/** One copy of the update status for the Update button, the page shown while ros.ai restarts and Settings ›
 * General. It reads the local server every minute, every second while something moves (a check, a download,
 * an update), and when the window comes back into focus. */
let status: UpdateStatus | undefined, timer: ReturnType<typeof setTimeout> | undefined;
// Set once an update starts: when, and since when the server has not answered.
let updatingSince = 0, downSince = 0;
const listeners = new Set<() => void>();
const publish = (next: UpdateStatus | undefined) => { status = next; for (const listener of listeners) listener(); };

// npm run dev only: ?update-preview=ready|downloading|source|steps|dmg shows that state without a release, so the
// button and Settings can be tried from a branch. Nothing is downloaded or restarted.
const preview = import.meta.env.DEV ? new URLSearchParams(location.search).get('update-preview') : null;
function previewStatus(kind: string): UpdateStatus {
  const base: UpdateStatus = { version: '0.1.0', install: 'app', enabled: true, auto: true, checking: false, checkedAt: new Date(Date.now() - 4 * 60_000).toISOString(), state: 'current' };
  const latest = { version: '0.2.0', url: 'https://github.com/arkdong/ros-ai/releases' };
  if (kind === 'ready') return { ...base, latest, state: 'ready', action: 'restart' };
  if (kind === 'downloading') return { ...base, latest, state: 'downloading', doneBytes: 64e6, totalBytes: 142e6 };
  if (kind === 'source') return { ...base, install: 'source', latest, state: 'available', action: 'update' };
  if (kind === 'steps') return { ...base, install: 'source', latest, state: 'available', action: 'steps', note: 'This checkout has changes that aren\'t committed, so ros.ai won\'t pull by itself.', commands: 'git pull && npm ci && npm run build' };
  if (kind === 'dmg') return { ...base, latest, state: 'available', action: 'steps', note: 'ros.ai is running from its disk image or the Downloads folder, so it can\'t replace itself. Drag it to Applications and open it from there.' };
  return base;
}

async function refresh() {
  clearTimeout(timer);
  if (preview) { if (!status) publish(previewStatus(preview)); return; }
  try {
    const next = await api<UpdateStatus>('/api/updates', { signal: AbortSignal.timeout(5000) });
    if (next.state === 'installing') updatingSince ||= Date.now();
    // Back after an update (or after one that could not finish): load the page this ros.ai serves.
    else if (updatingSince) { location.reload(); return; }
    downSince = 0;
    publish(next);
  } catch {
    // Restarting into the new version, or a ros.ai without updates.
    if (updatingSince && !downSince) downSince = Date.now();
  }
  schedule();
}
function schedule() {
  clearTimeout(timer);
  if (!listeners.size || preview) return;
  timer = setTimeout(() => void refresh(), updatingSince || status?.checking || status?.state === 'downloading' ? 1000 : 60_000);
}
const onFocus = () => void refresh();
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) { window.addEventListener('focus', onFocus); void refresh(); }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { clearTimeout(timer); window.removeEventListener('focus', onFocus); }
  };
}

export const useUpdates = () => useSyncExternalStore(subscribe, () => status);
/** During an update: how long it has taken, and how long the server has not answered, in milliseconds. */
export const updateWait = () => ({ waited: updatingSince ? Date.now() - updatingSince : 0, down: downSince ? Date.now() - downSince : 0 });

/** Asks GitHub now; the Mac app starts downloading what it finds. */
export async function checkForUpdates() {
  if (preview) { publish({ ...previewStatus(preview), checking: true }); setTimeout(() => publish({ ...previewStatus(preview), checkedAt: new Date().toISOString() }), 900); return; }
  if (status) publish({ ...status, checking: true });
  try { publish(await post<UpdateStatus>('/api/updates/check')); }
  finally { schedule(); }
}
/** Restarts into the downloaded app, or updates this checkout and restarts it. The page then waits for ros.ai to come back. */
export async function installUpdate() {
  if (preview) { publish({ ...status!, state: 'installing' }); setTimeout(() => publish(previewStatus(preview)), 6000); return; }
  const next = await post<UpdateStatus>('/api/updates/install');
  updatingSince = Date.now();
  publish(next);
  schedule();
}
export async function setAutoUpdates(auto: boolean) {
  if (preview) { publish({ ...status!, auto }); return; }
  publish(await api<UpdateStatus>('/api/updates/settings', { method: 'PUT', body: JSON.stringify({ auto }) }));
  schedule();
}
