/** The browser agents use (Plugins › Browser): the Chrome, Edge or Chromium on this computer that runs it, or none
 * yet, whether agents may use it, and the one-time Chromium download for a computer with neither. */
export type BrowserEngine = { kind: 'chrome' | 'edge' | 'chromium'; name: string };
export type BrowserDownload = { state: 'idle' } | { state: 'downloading'; percent: number | null } | { state: 'failed'; message: string };
export type BrowserStatus = { agents: boolean; engine: BrowserEngine | null; download: BrowserDownload; open: number; checked: { ok: boolean; message: string } | null };
