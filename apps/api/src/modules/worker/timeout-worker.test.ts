import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTimeoutWorker } from './timeout-worker.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('timeout polling lifecycle', () => {
  it('scans immediately, then at the configured interval, and stop cancels future work', async () => {
    vi.useFakeTimers();
    const scan = vi.fn().mockResolvedValue(undefined);
    const worker = startTimeoutWorker({ scan, intervalMs: 100 });
    expect(scan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(scan).toHaveBeenCalledTimes(2);
    await worker.stop();
    await worker.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan.mock.calls[0]![0]()).toBe(true);
  });
  it('does not overlap a slow scan and waits for it on shutdown', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const scan = vi.fn().mockReturnValue(pending);
    const worker = startTimeoutWorker({ scan, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(scan).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await stopping;
    await vi.advanceTimersByTimeAsync(1000);
    expect(stopped).toBe(true);
    expect(scan).toHaveBeenCalledTimes(1);
  });
  it('schedules the next interval from completion of a slow scan', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const scan = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const worker = startTimeoutWorker({ scan, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(1000);
    finish();
    await vi.advanceTimersByTimeAsync(99);
    expect(scan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(2);
    await worker.stop();
  });
  it('reports scan failure and retries next tick without an unhandled rejection', async () => {
    vi.useFakeTimers();
    const scan = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary DB failure'))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const worker = startTimeoutWorker({ scan, intervalMs: 100, onError });
    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(2);
    await worker.stop();
  });
  it.each([0, 99, 60001, 1.5, NaN])('rejects invalid interval %s', (intervalMs) => {
    expect(() => startTimeoutWorker({ scan: vi.fn(), intervalMs })).toThrow(RangeError);
  });
});
