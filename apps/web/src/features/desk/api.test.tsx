import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useResource } from './api';
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
describe('resource revalidation', () => {
  it('retains a successful snapshot during action refresh without reentering initial loading', async () => {
    const next = deferred();
    fetchMock.mockResolvedValueOnce(json({ value: 'loaded' })).mockReturnValueOnce(next.promise);
    const { result, rerender } = renderHook(
      ({ revision }) => useResource<{ value: string }>('/jobs', revision),
      { initialProps: { revision: 0 } },
    );
    await waitFor(() => expect(result.current.data?.value).toBe('loaded'));
    rerender({ revision: 1 });
    expect(result.current.data?.value).toBe('loaded');
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(true);
    await act(async () => next.resolve(json({ value: 'updated' })));
    expect(result.current.data?.value).toBe('updated');
    expect(result.current.settledRevision).toBe(1);
  });
  it('keeps the last good data visible when a background refresh fails', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ value: 1 }))
      .mockResolvedValueOnce(
        json({ error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Database unavailable' } }, 503),
      );
    const { result, rerender } = renderHook(
      ({ revision }) => useResource<{ value: number }>('/jobs', revision),
      { initialProps: { revision: 0 } },
    );
    await waitFor(() => expect(result.current.data?.value).toBe(1));
    rerender({ revision: 1 });
    await waitFor(() => expect(result.current.error).toContain('DEPENDENCY_UNAVAILABLE'));
    expect(result.current.data?.value).toBe(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(false);
  });
  it('retains filtered rows only within their explicit collection scope', async () => {
    const next = deferred(),
      other = deferred();
    fetchMock
      .mockResolvedValueOnce(json({ value: 'old jobs' }))
      .mockReturnValueOnce(next.promise)
      .mockReturnValueOnce(other.promise);
    const { result, rerender } = renderHook(
      ({ path, scope }) => useResource<{ value: string }>(path, 0, scope),
      { initialProps: { path: '/jobs', scope: 'jobs' } },
    );
    await waitFor(() => expect(result.current.data?.value).toBe('old jobs'));
    rerender({ path: '/jobs?zone=WEST', scope: 'jobs' });
    expect(result.current.data?.value).toBe('old jobs');
    expect(result.current.stale).toBe(true);
    rerender({ path: '/riders', scope: 'riders' });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    await act(async () => {
      next.resolve(json({ value: 'obsolete jobs' }));
      other.resolve(json({ value: 'riders' }));
    });
    expect(result.current.data?.value).toBe('riders');
  });
  it('does not allow an older GET to overwrite an authoritative mutation response', async () => {
    const old = deferred();
    fetchMock.mockResolvedValueOnce(json({ status: 'READY' })).mockReturnValueOnce(old.promise);
    const { result } = renderHook(() => useResource<{ status: string }>('/job'));
    await waitFor(() => expect(result.current.data?.status).toBe('READY'));
    act(() => result.current.reload());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    act(() => result.current.replace({ status: 'ACCEPTED' }));
    await act(async () => old.resolve(json({ status: 'READY' })));
    expect(result.current.data?.status).toBe('ACCEPTED');
    expect(result.current.refreshing).toBe(false);
  });
});

it('keeps a refresh error visible until a later retry actually succeeds', async () => {
  const next = deferred();
  fetchMock
    .mockResolvedValueOnce(json({ value: 1 }))
    .mockResolvedValueOnce(json({ error: { code: 'DOWN', message: 'Read failed' } }, 503))
    .mockReturnValueOnce(next.promise);
  const { result, rerender } = renderHook(
    ({ revision }) => useResource<{ value: number }>('/jobs', revision),
    { initialProps: { revision: 0 } },
  );
  await waitFor(() => expect(result.current.data?.value).toBe(1));
  rerender({ revision: 1 });
  await waitFor(() => expect(result.current.error).toContain('Read failed'));
  act(() => result.current.reload());
  expect(result.current.error).toContain('Read failed');
  expect(result.current.data?.value).toBe(1);
  await act(async () => next.resolve(json({ value: 2 })));
  expect(result.current.error).toBeUndefined();
  expect(result.current.data?.value).toBe(2);
});

it('does not fetch an inactive queue while on Overview', () => {
  const { result } = renderHook(() => useResource(null, 3));
  expect(result.current.loading).toBe(false);
  expect(result.current.settledRevision).toBe(3);
  expect(fetchMock).not.toHaveBeenCalled();
});
