import { useSyncExternalStore } from 'react';
import { PLUGINS, type PluginId } from '../shared/plugins';
import type { PluginReadiness, SuggestionStatus } from '../shared/plugin-hints';
import { api, post } from './api';

/** One copy of what plugin suggestions need for the chip, the card and Settings: the switch, what is silenced, and which
 * plugins agents can use now. Read when the first of them shows, when the window comes back into focus, and on demand
 * (a new name in the draft, a sign-in in progress). */
let status: SuggestionStatus | undefined, loading: Promise<SuggestionStatus | undefined> | undefined;
const listeners = new Set<() => void>();
const publish = (next: SuggestionStatus) => { status = next; for (const listener of listeners) listener(); };

export function reloadSuggestions() {
  loading ??= api<SuggestionStatus>('/api/suggestions').then(next => { publish(next); return next; }, () => status).finally(() => { loading = undefined; });
  return loading;
}
const onFocus = () => void reloadSuggestions();
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) { window.addEventListener('focus', onFocus); void reloadSuggestions(); }
  return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener('focus', onFocus); };
}
export const useSuggestions = () => useSyncExternalStore(subscribe, () => status);

/** Saves a change and shows the status the server sends back. */
export async function changeSuggestions(path: string, init: RequestInit) { publish(await api<SuggestionStatus>(path, init)); }
/** later: Not now (this project, a week). never: Don't suggest this plugin again. done: carried on after connecting. */
export const decideSuggestion = (body: { decision: 'later' | 'never' | 'done'; projectId: string; turnId?: string; pluginId?: PluginId }) => changeSuggestions('/api/suggestions/decide', { method: 'POST', body: JSON.stringify(body) });

export const pluginName = (id: PluginId) => PLUGINS.find(plugin => plugin.id === id)?.name ?? id;
export const readiness = (value: SuggestionStatus | undefined, id: PluginId): PluginReadiness | undefined => value?.plugins[id];
/** Whether the person asked not to see this plugin here: Not now in this project, or Don't suggest again. */
export const silenced = (value: SuggestionStatus | undefined, id: PluginId, projectId: string) => Boolean(value?.silenced.some(item => item.pluginId === id && (item.projectId === null || item.projectId === projectId)));

/** The Mac app adds ros.ai/<version> to its user agent; it opens other sites in the system browser. */
const macApp = () => / ros\.ai\/\S+$/u.test(navigator.userAgent);
/** Opens an app's sign-in in a window of its own, so the conversation and the draft stay where they are. The window opens
 * before ros.ai asks for the address, while the click still counts, and never keeps a way back to this page. In the Mac
 * app the sign-in opens in the system browser. Returns the address, to open again by hand if the window was blocked. */
export async function openSignIn(id: PluginId): Promise<{ url?: string; connected?: boolean }> {
  const popup = macApp() ? null : window.open('', 'ros-ai-sign-in', 'popup,width=520,height=720');
  if (popup) { popup.opener = null; popup.document.title = `${pluginName(id)} sign-in`; if (popup.document.body) popup.document.body.textContent = `Opening the ${pluginName(id)} sign-in…`; }
  try {
    const started = await post<{ authorizationUrl?: string; connected?: boolean }>(`/api/apps/${id}/connect`, { window: true });
    if (!started.authorizationUrl) { popup?.close(); return { connected: true }; }
    if (popup && !popup.closed) popup.location.href = started.authorizationUrl;
    else window.open(started.authorizationUrl, '_blank', 'noopener');
    return { url: started.authorizationUrl };
  } catch (cause) { popup?.close(); throw cause; }
}
