import { useEffect, useState } from 'react';

export function readSaved<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(`ros-ai:${key}`); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}
export function saveLocal(key: string, value: unknown) {
  try { localStorage.setItem(`ros-ai:${key}`, JSON.stringify(value)); } catch { /* Durable project data is still saved by the service. */ }
}
export function useDraft(key: string, fallback = '') {
  const [value, setValue] = useState(() => readSaved(key, fallback));
  useEffect(() => saveLocal(key, value), [key, value]);
  return [value, setValue] as const;
}
