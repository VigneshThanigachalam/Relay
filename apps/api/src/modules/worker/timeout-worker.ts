type Dependencies = {
  scan: (shouldStop: () => boolean) => Promise<unknown>;
  intervalMs: number;
  onError?: () => void;
};
export function startTimeoutWorker({
  scan,
  intervalMs,
  onError = () => console.error('Timeout scan failed'),
}: Dependencies) {
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000)
    throw new RangeError('Timeout interval must be 100–60000 ms');
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function tick() {
    try {
      await scan(() => stopped);
    } catch {
      onError();
    } finally {
      // Schedule after completion, not setInterval: one slow scan must not
      // overlap its successor. Other processes remain safe through DB guards.
      if (!stopped)
        timer = setTimeout(() => {
          inFlight = tick();
        }, intervalMs).unref();
    }
  }
  // Scan persisted deadlines immediately on startup, including overdue work
  // created by an earlier process. Timers are only a polling trigger.
  let inFlight = tick();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
