import { fileMediaType } from '../shared/files';
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> { return (await request<T>(path, init)).value; }
/** A project read with the stamp of the project's newest write when the read began (0 when the server gave none). */
export async function stamped<T>(path: string): Promise<{ value: T; stamp: number }> {
  const { value, response } = await request<T>(path, {});
  return { value, stamp: Number(response.headers.get('X-Ros-Stamp')) || 0 };
}
async function request<T>(path: string, init: RequestInit): Promise<{ value: T; response: Response }> {
  const response = await fetch(path, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', ...init.headers },
  }).catch((error: unknown) => {
    throw new Error(`The local request ${error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'could not reach ros.ai'}. Admission may be unknown. Refresh saved activity before sending again; no request was automatically retried.`);
  });
  const value = await response.json().catch(() => { throw new Error(`The local service returned an unreadable response (${response.status}). Inspect saved activity before sending again.`); });
  // The status travels with the message, so a caller can tell a conflict from other refusals.
  if (!response.ok) throw Object.assign(new Error(value.error || `Request failed (${response.status})`), { status: response.status });
  return { value: value as T, response };
}
export function post<T>(path: string, body?: unknown) {
  return api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}
/** Sends a file as the request body, for example a PDF dropped on the canvas. */
export async function upload<T>(path: string, file: File): Promise<T> {
  return api<T>(path, { method: 'POST', body: file, headers: { 'Content-Type': file.type || fileMediaType(file.name) || 'application/octet-stream' }, signal: AbortSignal.timeout(Math.max(120_000, file.size / 2_000)) });
}
