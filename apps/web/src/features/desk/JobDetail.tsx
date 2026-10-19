import { useRef, useState } from 'react';
import {
  ApiError,
  message,
  pendingAssignment,
  request,
  saveAssignment,
  useResource,
  type AssignmentCommand,
} from './api';
import { Badge, date, ErrorBox, label, Pager } from './shared';
import type { History, Job, Recommendation, Rider } from './types';

type Props = {
  id: string;
  revision: number;
  changed: () => void;
  riders: Rider[];
  close: () => void;
};
export function JobDetail({ id, revision, changed, riders, close }: Props) {
  const jobRead = useResource<{ data: Job }>(`/jobs/${id}`, revision);
  const [page, setPage] = useState(1);
  const history = useResource<History>(`/jobs/${id}/history?page=${page}&pageSize=20`, revision);
  const [advice, setAdvice] = useState<{ version: number; data: Recommendation } | null>(null);
  const [chosen, setChosen] = useState(''),
    [reason, setReason] = useState(''),
    [error, setError] = useState('');
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [command, setCommand] = useState(() => pendingAssignment(id));
  // The ref closes the small interval before React renders disabled controls.
  const running = useRef(false);
  const job = jobRead.data?.data;
  const riderName = (riderId: string) => {
    const r = riders.find((r) => r.id === riderId);
    return r ? `${r.name} · ${r.code}` : riderId;
  };
  async function mutate(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      changed();
    } catch (e) {
      setError(message(e));
      changed();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function action(kind: string) {
    if (!job) return;
    const response = kind === 'accept' || kind === 'reject';
    const path = response
      ? `/assignments/${job.activeAssignmentId}/${kind}`
      : `/jobs/${id}/${kind}`;
    await request(path, {
      method: 'POST',
      actor: response ? `rider:${job.assignedRiderId}` : 'dispatcher:demo',
      body:
        kind === 'reject' || kind === 'cancel'
          ? { reason: reason.trim() }
          : kind === 'pickup' || kind === 'deliver'
            ? { assignmentId: job.activeAssignmentId }
            : {},
    });
    setNotice(`Recorded: ${label(kind)}.`);
    setReason('');
    setAdvice(null);
  }
  async function assign(existing?: AssignmentCommand) {
    const cmd = existing ?? {
      key: crypto.randomUUID(),
      body: { riderId: chosen, ...(reason.trim() ? { overrideReason: reason.trim() } : {}) },
    };
    // Save before sending. Timeouts/503 retain the exact command across reloads;
    // definitive validation/conflict responses allow a corrected new action.
    setCommand(cmd);
    saveAssignment(id, cmd);
    try {
      await request(`/jobs/${id}/assignments`, { method: 'POST', ...cmd });
      setCommand(null);
      saveAssignment(id, null);
      setAdvice(null);
      setReason('');
      setNotice('Assignment recorded. Capacity reserved.');
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) {
        setCommand(null);
        saveAssignment(id, null);
      }
      throw e;
    }
  }
  const snapshot = advice && job && advice.version === job.version ? advice.data : null;
  const canRecommend = job?.status === 'READY_FOR_ASSIGNMENT' || job?.status === 'MANUAL_QUEUE';
  return (
    <aside className="panel detail" aria-label="Job details">
      <div className="section-head">
        <h2>Job details</h2>
        <button onClick={close}>Close</button>
      </div>
      {jobRead.loading && <p role="status">Loading job…</p>}
      {jobRead.error && <ErrorBox error={jobRead.error} retry={jobRead.reload} />}
      {job && (
        <>
          <p className="eyebrow">{job.orderReference}</p>
          <h3>{label(job.status)}</h3>
          <p>
            {job.pickupZone} → {job.deliveryZone} · {job.loadUnits} units · {label(job.priority)}
          </p>
          <dl className="facts">
            <div>
              <dt>Received</dt>
              <dd>{date(job.createdAt)}</dd>
            </div>
            <div>
              <dt>Deadline</dt>
              <dd>{date(job.deadlineAt)}</dd>
            </div>
            <div>
              <dt>Rider</dt>
              <dd>{job.assignedRiderId ? riderName(job.assignedRiderId) : 'Unassigned'}</dd>
            </div>
            {job.manualReason && (
              <div>
                <dt>Manual reason</dt>
                <dd>{label(job.manualReason)}</dd>
              </div>
            )}
          </dl>
          <fieldset disabled={busy || jobRead.loading || !!jobRead.error} className="actions">
            <legend>Dispatch actions</legend>
            {job.status === 'NEW' && (
              <button className="primary" onClick={() => void mutate(() => action('ready'))}>
                Mark ready
              </button>
            )}
            {canRecommend && (
              <button
                className="primary"
                onClick={() =>
                  void mutate(async () => {
                    const result = await request<{ data: Recommendation }>(
                      `/jobs/${id}/recommendations`,
                      { method: 'POST', body: {} },
                    );
                    setAdvice({
                      version:
                        job.version +
                        (result.data.eligible.length === 0 && job.status === 'READY_FOR_ASSIGNMENT'
                          ? 1
                          : 0),
                      data: result.data,
                    });
                    setChosen(result.data.eligible[0]?.riderId ?? '');
                  })
                }
              >
                Review recommendations
              </button>
            )}
            {job.status === 'AWAITING_CONFIRMATION' && (
              <>
                <p className="muted">
                  Simulate the assigned rider’s response. The server decides whether the deadline
                  has passed.
                </p>
                <button className="primary" onClick={() => void mutate(() => action('accept'))}>
                  Accept assignment
                </button>
                <button
                  disabled={!reason.trim()}
                  onClick={() => void mutate(() => action('reject'))}
                >
                  Reject assignment
                </button>
              </>
            )}
            {job.status === 'ACCEPTED' && (
              <button className="primary" onClick={() => void mutate(() => action('pickup'))}>
                Record pickup
              </button>
            )}
            {job.status === 'PICKED_UP' && (
              <button className="primary" onClick={() => void mutate(() => action('deliver'))}>
                Complete delivery
              </button>
            )}
            {!['DELIVERED', 'CANCELLED', 'PICKED_UP'].includes(job.status) && (
              <>
                <label>
                  Operational reason
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={500}
                    placeholder="Required for override, rejection or cancellation"
                  />
                </label>
                <button
                  className="danger"
                  disabled={!reason.trim()}
                  onClick={() => void mutate(() => action('cancel'))}
                >
                  Cancel job
                </button>
              </>
            )}
          </fieldset>
          {command && (
            <div className="warning">
              <p>
                An assignment response was not confirmed. Retry the saved command to recover its
                outcome.
              </p>
              <button disabled={busy} onClick={() => void mutate(() => assign(command))}>
                Retry exact assignment
              </button>
            </div>
          )}
          {snapshot && canRecommend && (
            <section aria-label="Rider recommendations">
              <div className="section-head">
                <h3>Rider recommendations</h3>
                <small>
                  v{snapshot.scoringVersion.replace('v', '')} · {date(snapshot.generatedAt)}
                </small>
              </div>
              <p className="muted">
                Lowest cost ranks first. Advice does not reserve capacity; assignment checks it
                again.
              </p>
              {snapshot.eligible.length === 0 && (
                <p className="empty">
                  No eligible riders. The job is available in the manual queue.
                </p>
              )}
              <fieldset disabled={busy || !!command || jobRead.loading || !!jobRead.error}>
                {snapshot.eligible.map((r) => (
                  <label
                    className={`candidate ${chosen === r.riderId ? 'chosen' : ''}`}
                    key={r.riderId}
                  >
                    <input
                      type="radio"
                      name="candidate"
                      checked={chosen === r.riderId}
                      onChange={() => setChosen(r.riderId)}
                    />
                    <span>
                      <strong>
                        #{r.rank} {riderName(r.riderId)}
                      </strong>
                      <span className="score">
                        Cost {r.totalCost} · ~{r.estimatedMinutes} min · {r.availableUnits} free
                        units · {r.activeJobCount} active
                      </span>
                      <span className="muted">
                        Travel {r.breakdown.travelCost} + workload {r.breakdown.workloadCost} +
                        deadline {r.breakdown.deadlineCost}
                      </span>
                      <span className="muted">
                        {r.reasons.join(' · ')}
                        {r.estimatedByFallback ? ' · Fallback estimate' : ''}
                      </span>
                    </span>
                  </label>
                ))}
                {snapshot.eligible.length > 0 && (
                  <button
                    className="primary"
                    disabled={
                      !chosen || (chosen !== snapshot.eligible[0]?.riderId && !reason.trim())
                    }
                    onClick={() => void mutate(() => assign())}
                  >
                    {job.status === 'MANUAL_QUEUE'
                      ? 'Reassign selected rider'
                      : 'Assign selected rider'}
                  </button>
                )}
              </fieldset>
              <details>
                <summary>Excluded riders ({snapshot.excluded.length})</summary>
                {snapshot.excluded.map((r) => (
                  <p key={r.riderId}>
                    <strong>{riderName(r.riderId)}</strong>: {r.reasons.join('; ')}
                  </p>
                ))}
              </details>
            </section>
          )}
        </>
      )}
      {busy && <p role="status">Recording action…</p>}
      {notice && (
        <p className="success" role="status">
          {notice}
        </p>
      )}
      {error && <ErrorBox error={error} />}
      <section aria-label="Operational history">
        <h3>Operational history</h3>
        {history.loading && <p>Loading history…</p>}
        {history.error && <ErrorBox error={history.error} retry={history.reload} />}
        {history.data && (
          <>
            <h4>Assignment attempts</h4>
            {history.data.data.attempts.length === 0 && (
              <p className="muted">No assignment attempts.</p>
            )}
            {history.data.data.attempts.map((a) => (
              <details key={a.id} className="attempt">
                <summary>
                  <Badge value={a.status} /> {riderName(a.riderId)} · {a.loadUnits} units
                </summary>
                <p>
                  Assigned {date(a.assignedAt)} · expires {date(a.expiresAt)}
                </p>
                <p>
                  {a.endReason ?? 'No end reason'} · capacity released{' '}
                  {date(a.reservationReleasedAt)}
                </p>
                {a.overrideReason && <p>Override/note: {a.overrideReason}</p>}
                <details>
                  <summary>Stored scoring snapshot</summary>
                  <pre>{JSON.stringify(a.recommendationSnapshot, null, 2)}</pre>
                </details>
              </details>
            ))}
            <h4>Chronological events</h4>
            <ol className="timeline">
              {history.data.data.events.map((e) => (
                <li key={e.id}>
                  <strong>
                    #{e.sequence} {label(e.type)}
                  </strong>
                  <small>
                    {date(e.occurredAt)} · {e.actor}
                  </small>
                  <details>
                    <summary>Event details</summary>
                    <pre>{JSON.stringify(e.details, null, 2)}</pre>
                  </details>
                </li>
              ))}
            </ol>
            <Pager
              pagination={{
                ...history.data.pagination,
                total: Math.max(
                  history.data.pagination.total,
                  history.data.attemptsPagination.total,
                ),
              }}
              change={setPage}
            />
          </>
        )}
      </section>
    </aside>
  );
}
