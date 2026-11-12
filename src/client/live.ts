import { useEffect, useRef, useState } from 'react';

/**
 * The page's live connection to its server. `onChanged(stamp)` is called when the project shown has writes up to
 * `stamp`, whoever made them: this window, another one, an agent or the project folder. Returns whether the connection
 * is open; while it is not (the server is restarting) the page goes back to asking on a timer.
 */
export function useLive(projectId: string | null, onChanged: (stamp: number) => void): boolean {
  const [connected, setConnected] = useState(false);
  const changed = useRef(onChanged), watched = useRef(projectId), socket = useRef<WebSocket | null>(null);
  changed.current = onChanged;
  watched.current = projectId;
  const watch = (to: WebSocket) => to.send(JSON.stringify({ type: 'watch', projectId: watched.current }));
  useEffect(() => {
    if (typeof WebSocket === 'undefined') return;
    let closed = false, attempt = 0, retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      const next = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`);
      socket.current = next;
      // The server answers a watch with the project's newest stamp, so a page that was away sees whether it missed anything.
      next.onopen = () => { attempt = 0; setConnected(true); watch(next); };
      next.onmessage = event => {
        let value: { type?: string; projectId?: string; stamp?: number };
        try { value = JSON.parse(String(event.data)) as typeof value; } catch { return; }
        if (value?.type === 'changed' && value.projectId === watched.current && typeof value.stamp === 'number') changed.current(value.stamp);
      };
      next.onerror = () => next.close();
      next.onclose = () => {
        if (socket.current === next) socket.current = null;
        setConnected(false);
        if (!closed) retry = setTimeout(open, Math.min(15_000, 500 * 2 ** attempt++));
      };
    };
    open();
    return () => { closed = true; clearTimeout(retry); socket.current?.close(); };
  }, []);
  useEffect(() => { if (socket.current?.readyState === WebSocket.OPEN) watch(socket.current); }, [projectId]);
  return connected;
}
