import { useEffect, useState } from 'react';

export function readSaved<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(`ros-ai:${key}`); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}
export function saveLocal(key: string, value: unknown) {
  try { localStorage.setItem(`ros-ai:${key}`, JSON.stringify(value)); } catch { /* Durable project data is still saved by the service. */ }
}
/** Typed text that survives switching views, projects and windows, and closing the app. A read-only view passes keep = false, so it neither shows nor leaves a draft. When the key changes (another project or block) the draft for that key is loaded instead of carrying the old text over. */
export function useDraft(key: string, fallback = '', keep = true) {
  const [draft, setDraft] = useState(() => ({ key, value: keep ? readSaved(key, fallback) : fallback }));
  const current = draft.key === key ? draft : { key, value: keep ? readSaved(key, fallback) : fallback };
  if (current !== draft) setDraft(current);
  useEffect(() => { if (keep) saveLocal(current.key, current.value); }, [current.key, current.value, keep]);
  const setValue = (next: string | ((value: string) => string)) => setDraft(previous => ({ key: previous.key, value: typeof next === 'function' ? next(previous.value) : next }));
  return [current.value, setValue] as const;
}
