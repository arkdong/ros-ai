import { useEffect, useState } from 'react';

export function readSaved<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(`ros-ai:${key}`); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}
export function saveLocal(key: string, value: unknown) {
  try { localStorage.setItem(`ros-ai:${key}`, JSON.stringify(value)); } catch { /* Durable project data is still saved by the service. */ }
}
function removeLocal(key: string) {
  try { localStorage.removeItem(`ros-ai:${key}`); } catch { /* Nothing kept to remove. */ }
}
/** A saved list, keeping only the entries this copy of ros.ai can still show, so one saved by an older or newer copy breaks nothing. */
export function readSavedList<T>(key: string, valid: (item: Partial<T> | null) => boolean): T[] {
  const value = readSaved<unknown>(key, []);
  return Array.isArray(value) ? value.filter(item => valid(item && typeof item === 'object' ? item : null)) : [];
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

type EditDraft = { value: string; base: string };
type EditState = EditDraft & { key: string; saved: string };
function readEditDraft(key: string): EditDraft | null {
  const draft = readSaved<unknown>(key, null) as Partial<EditDraft> | null;
  return draft && typeof draft === 'object' && typeof draft.value === 'string' && typeof draft.base === 'string' ? { value: draft.value, base: draft.base } : null;
}
/** Text typed into a block, kept in the browser until the service has it, together with the block's text it was typed
 * on (its base). The draft comes back only while the block still holds that text, so an Undo, an agent's edit, a change
 * from the project folder or from another window is never written over by an old draft. While the editor is open it
 * follows the block's text whenever nothing unsaved was typed. A draft kept by an older copy of ros.ai has no base and
 * is dropped. A read-only view passes keep = false, so it neither shows nor leaves a draft.
 * saved(text): the service took text from this editor, so the draft goes, or what was typed since counts from that
 * text. It works after the editor has closed too, as a save sent on close ends later. */
export function useEditDraft(key: string, saved: string, keep = true) {
  const load = (): EditState => {
    const draft = keep ? readEditDraft(key) : null;
    return { key, value: draft && draft.base === saved ? draft.value : saved, base: saved, saved };
  };
  const [state, setState] = useState(load);
  let current = state;
  if (state.key !== key) current = load();
  else if (state.saved !== saved) current = { ...state, saved, ...(state.value === state.base ? { value: saved, base: saved } : state.value === saved ? { base: saved } : {}) };
  if (current !== state) setState(current);
  useEffect(() => {
    if (!keep) return;
    if (current.value === current.saved) removeLocal(current.key); else saveLocal(current.key, { value: current.value, base: current.base });
  }, [current.key, current.value, current.base, current.saved, keep]);
  const setValue = (next: string | ((value: string) => string)) => setState(previous => ({ ...previous, value: typeof next === 'function' ? next(previous.value) : next }));
  const markSaved = (text: string) => {
    if (keep) { const draft = readEditDraft(key); if (draft?.value === text) removeLocal(key); else if (draft) saveLocal(key, { value: draft.value, base: text }); }
    setState(previous => previous.key === key ? { ...previous, base: text } : previous);
  };
  return [current.value, setValue, markSaved] as const;
}
