export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
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
  return value as T;
}
export function post<T>(path: string, body?: unknown) {
  return api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}
/** Sends a file as the request body, for example a PDF dropped on the canvas. */
export async function upload<T>(path: string, file: File): Promise<T> {
  return api<T>(path, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' }, signal: AbortSignal.timeout(120_000) });
}
