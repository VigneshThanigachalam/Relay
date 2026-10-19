import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public requestId?: string,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: object;
    key?: string;
    actor?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.method ? { 'X-Actor-Id': options.actor ?? 'dispatcher:demo' } : {}),
      ...(options.key ? { 'Idempotency-Key': options.key } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: options.signal ?? AbortSignal.timeout(20000),
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string; code?: string; details?: { path: string; message: string }[] };
    requestId?: string;
  } | null;
  if (!response.ok) {
    const details = payload?.error?.details?.map((d) => `${d.path}: ${d.message}`).join('; ');
    throw new ApiError(
      [payload?.error?.message ?? `Request failed (${response.status})`, details]
        .filter(Boolean)
        .join(' — '),
      response.status,
      payload?.error?.code ?? 'HTTP_ERROR',
      payload?.requestId,
    );
  }
  if (!payload) throw new Error('API returned an invalid JSON response');
  return payload as T;
}
export const message = (error: unknown) =>
  error instanceof ApiError
    ? `${error.message} [${error.code}]${error.requestId ? ` · Request ${error.requestId}` : ''}`
    : 'Could not reach the API. Check the connection and retry the same action.';

// Abort old reads when the selected row/filter changes. Poll only reads; a
// recommendation is an audited command and must never run on a timer.
export function useResource<T>(path: string, revision = 0) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({
    loading: true,
  });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    setState({ loading: true });
    const read = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const data = await request<T>(path, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        });
        if (!controller.signal.aborted) setState({ data, loading: false });
      } catch (error) {
        if (!controller.signal.aborted)
          setState((old) => ({ ...old, loading: false, error: message(error) }));
      } finally {
        fetching = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [path, revision, retry]);
  const reload = useCallback(() => setRetry((n) => n + 1), []);
  return { ...state, reload };
}
export type AssignmentCommand = { key: string; body: { riderId: string; overrideReason?: string } };
const commandKey = (id: string) => `relay:assignment:${id}`;
export function pendingAssignment(id: string): AssignmentCommand | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(commandKey(id)) ?? 'null');
    if (
      raw &&
      typeof raw === 'object' &&
      'key' in raw &&
      typeof raw.key === 'string' &&
      'body' in raw &&
      raw.body &&
      typeof raw.body === 'object' &&
      'riderId' in raw.body &&
      typeof raw.body.riderId === 'string'
    )
      return raw as AssignmentCommand;
  } catch {
    /* Storage may be unavailable; in-session state still retains retries. */
  }
  return null;
}
export function saveAssignment(id: string, value: AssignmentCommand | null) {
  try {
    if (value) localStorage.setItem(commandKey(id), JSON.stringify(value));
    else localStorage.removeItem(commandKey(id));
  } catch {
    /* Dispatch remains usable with in-session retry state. */
  }
}
