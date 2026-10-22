import { useEffect, useState } from 'react';

export function readSaved<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(`ros-ai:${key}`); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}
export function saveLocal(key: string, value: unknown) {
  try { localStorage.setItem(`ros-ai:${key}`, JSON.stringify(value)); } catch { /* Durable project data is still saved by the service. */ }
}
/** A read-only view passes keep = false, so it neither shows nor leaves a draft. */
export function useDraft(key: string, fallback = '', keep = true) {
  const [value, setValue] = useState(() => keep ? readSaved(key, fallback) : fallback);
  useEffect(() => { if (keep) saveLocal(key, value); }, [key, value, keep]);
  return [value, setValue] as const;
}
