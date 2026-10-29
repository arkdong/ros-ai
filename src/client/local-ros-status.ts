import { useSyncExternalStore } from 'react';
import type { LocalRosStatus } from '../shared/local-ros';
import { api, post } from './api';

/** One copy of ROS on this computer's status for every place that shows it: the download chip, the first run, Connect
 * your tools and Agents › ROS. Read when the first of them shows and when the window comes back into focus; every
 * second and a half while the download runs or ROS starts, so they all move together. */
let status: LocalRosStatus | undefined, loading: Promise<LocalRosStatus | undefined> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const busy = (value: LocalRosStatus | undefined) => value?.state === 'downloading' || value?.state === 'starting';
function publish(next: LocalRosStatus) {
  status = next;
  for (const listener of listeners) listener();
  if (timer) { clearTimeout(timer); timer = undefined; }
  if (busy(next) && listeners.size) timer = setTimeout(() => void reloadLocalRos(), 1500);
}

export function reloadLocalRos() {
  loading ??= api<LocalRosStatus>('/api/local-ros').then(next => { publish(next); return next; }, () => status).finally(() => { loading = undefined; });
  return loading;
}
const onFocus = () => void reloadLocalRos();
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) { window.addEventListener('focus', onFocus); void reloadLocalRos(); }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { window.removeEventListener('focus', onFocus); if (timer) { clearTimeout(timer); timer = undefined; } }
  };
}
const idle = () => () => undefined;
/** off: the public demo, which has no ROS of its own to download, never asks. */
export const useLocalRosStatus = (on = true) => useSyncExternalStore(on ? subscribe : idle, () => on ? status : undefined);

/** Starts, cancels or removes the download and shows the answer everywhere at once. */
export async function changeLocalRos(action: 'download' | 'cancel' | 'remove') {
  const next = await post<LocalRosStatus>(`/api/local-ros/${action}`);
  publish(next);
  return next;
}
/** What the download is worth in words: "1.2 GB". */
export const gb = (bytes = 0) => `${(bytes / 1e9).toFixed(1)} GB`;
/** How long the rest takes at the current speed, rounded the way a person says it, or nothing while unknown. */
export function timeLeft(value: LocalRosStatus) {
  if (!value.bytesPerSecond || !value.totalBytes) return '';
  const seconds = (value.totalBytes - (value.doneBytes ?? 0)) / value.bytesPerSecond;
  if (seconds < 50) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `about ${minutes} min left` : `about ${Math.round(minutes / 6) / 10} h left`;
}
export const percentOf = (value: LocalRosStatus | undefined) => value?.totalBytes ? Math.min(100, Math.floor(((value.doneBytes ?? 0) / value.totalBytes) * 100)) : 0;
