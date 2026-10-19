import { JobHistory } from './JobHistory';
import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  message,
  pendingAssignment,
  request,
  saveAssignment,
  useResource,
  type AssignmentCommand,
} from './api';
import { Icon } from './Icon';
import { useNotify } from './feedback';
import { Badge, date, Empty, ErrorBox, initials, label, Skeleton, titleCase } from './shared';
import type { History, Job, Recommendation, Rider } from './types';

type Action =
  | 'ready'
  | 'accept'
  | 'reject'
  | 'pickup'
  | 'deliver'
  | 'cancel'
  | 'recommend'
  | 'assign'
  | 'retry';
const progress: Record<Action, string> = {
  ready: 'Marking job ready…',
  accept: 'Confirming assignment…',
  reject: 'Recording rejection…',
  pickup: 'Recording pickup…',
  deliver: 'Completing delivery…',
  cancel: 'Cancelling delivery…',
  recommend: 'Evaluating available riders…',
  assign: 'Reserving capacity and assigning rider…',
  retry: 'Recovering the original assignment…',
};
const completed: Record<string, string> = {
  ready: 'Job is ready for assignment',
  accept: 'Assignment accepted',
  reject: 'Assignment rejected · moved to manual queue',
  pickup: 'Pickup recorded',
  deliver: 'Delivery completed · capacity released',
  cancel: 'Delivery cancelled',
};
export function JobDetail({
  id,
  revision,
  changed,
  riders,
  close,
}: {
  id: string;
  revision: number;
  changed: () => void;
  riders: Rider[];
  close: () => void;
}) {
  const jobRead = useResource<{ data: Job }>(`/jobs/${id}`, revision);
  const [page, setPage] = useState(1),
    [view, setView] = useState<'overview' | 'activity'>('overview');
  const history = useResource<History>(
    `/jobs/${id}/history?page=${page}&pageSize=20`,
    revision,
    `history:${id}`,
  );
  const [advice, setAdvice] = useState<{ version: number; data: Recommendation } | null>(null);
  const [chosen, setChosen] = useState(''),
    [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<Action | null>(null),
    [command, setCommand] = useState(() => pendingAssignment(id));
  const running = useRef(false);
  const recommendationAnchor = useRef<HTMLElement>(null);
  const notify = useNotify();
  const job = jobRead.data?.data;
  const riderName = (riderId: string) => {
    const r = riders.find((r) => r.id === riderId);
    return r ? `${r.name} · ${r.code}` : riderId;
  };
  async function mutate(kind: Action, task: () => Promise<{ title: string; description: string }>) {
    if (running.current) return;
    running.current = true;
    setBusy(kind);
    setError('');
    setNotice('');
    try {
      const outcome = await task();
      setNotice(outcome.title);
      notify({ ...outcome, type: 'success' });
      changed();
    } catch (e) {
      setError(message(e));
      notify({
        type: 'error',
        title: 'Action needs your attention',
        description:
          e instanceof ApiError
            ? e.message
            : 'The response was not confirmed. Check the connection and retry the same command.',
      });
      changed();
    } finally {
      running.current = false;
      setBusy(null);
    }
  }
  async function action(kind: Exclude<Action, 'recommend' | 'assign' | 'retry'>) {
    if (!job) throw new Error('Job is not loaded');
    const response = kind === 'accept' || kind === 'reject';
    const path = response
      ? `/assignments/${job.activeAssignmentId}/${kind}`
      : `/jobs/${id}/${kind}`;
    const result = await request<{ data: Job | { job: Job } }>(path, {
      method: 'POST',
      actor: response ? `rider:${job.assignedRiderId}` : 'dispatcher:demo',
      body:
        kind === 'reject' || kind === 'cancel'
          ? { reason: reason.trim() }
          : kind === 'pickup' || kind === 'deliver'
            ? { assignmentId: job.activeAssignmentId }
            : {},
    });
    const updated = 'job' in result.data ? result.data.job : result.data;
    jobRead.replace({ data: updated });
    setReason('');
    setAdvice(null);
    return {
      title: completed[kind] ?? 'Action recorded',
      description: `${job.orderReference} · State and operational history are up to date.`,
    };
  }
  async function recommend() {
    if (!job) throw new Error('Job is not loaded');
    const result = await request<{ data: Recommendation }>(`/jobs/${id}/recommendations`, {
      method: 'POST',
      body: {},
    });
    setAdvice({
      version:
        job.version +
        (result.data.eligible.length === 0 && job.status === 'READY_FOR_ASSIGNMENT' ? 1 : 0),
      data: result.data,
    });
    setChosen(result.data.eligible[0]?.riderId ?? '');
    return {
      title: result.data.eligible.length
        ? 'Recommendations ready'
        : 'No eligible riders · manual review needed',
      description: `${result.data.eligible.length} eligible riders. ${result.data.excluded.length} excluded with reasons recorded.`,
    };
  }
  async function assign(existing?: AssignmentCommand) {
    const cmd = existing ?? {
      key: crypto.randomUUID(),
      body: { riderId: chosen, ...(reason.trim() ? { overrideReason: reason.trim() } : {}) },
    };
    // Preserve the exact receipt before sending. A lost response may still commit;
    // only a definitive 4xx allows discarding it for a corrected new command.
    setCommand(cmd);
    saveAssignment(id, cmd);
    try {
      const result = await request<{ data: { job: Job }; replayed: boolean }>(
        `/jobs/${id}/assignments`,
        { method: 'POST', ...cmd },
      );
      jobRead.replace({ data: result.data.job });
      setCommand(null);
      saveAssignment(id, null);
      setAdvice(null);
      setReason('');
      return {
        title: result.replayed
          ? 'Original assignment recovered'
          : 'Rider assigned · awaiting confirmation',
        description: `${job?.orderReference ?? 'Delivery'} · Capacity is reserved. The rider can now respond.`,
      };
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) {
        setCommand(null);
        saveAssignment(id, null);
      }
      throw e;
    }
  }
  const snapshot = advice && job && advice.version === job.version ? advice.data : null;
  useEffect(() => {
    if (snapshot)
      recommendationAnchor.current?.scrollIntoView?.({
        behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
        block: 'start',
      });
  }, [snapshot?.generatedAt]);
  const canRecommend = job?.status === 'READY_FOR_ASSIGNMENT' || job?.status === 'MANUAL_QUEUE';
  const terminal = job?.status === 'DELIVERED' || job?.status === 'CANCELLED';
  const disabled = !!busy || jobRead.loading || !!jobRead.error;
  const stateIndex = job
    ? [
        'NEW',
        'READY_FOR_ASSIGNMENT',
        'AWAITING_CONFIRMATION',
        'ACCEPTED',
        'PICKED_UP',
        'DELIVERED',
      ].indexOf(job.status)
    : -1;
  const button = (
    kind: Exclude<Action, 'recommend' | 'assign' | 'retry'>,
    text: string,
    primary = true,
    requiresReason = false,
  ) => (
    <button
      className={primary ? 'primary' : kind === 'cancel' ? 'danger subtle' : 'secondary'}
      disabled={disabled || (requiresReason && !reason.trim())}
      onClick={() => void mutate(kind, () => action(kind))}
    >
      {busy === kind ? (
        <Icon name="loader" className="spin" />
      ) : (
        <Icon
          name={
            kind === 'deliver' || kind === 'accept'
              ? 'check'
              : kind === 'cancel'
                ? 'close'
                : 'arrow'
          }
        />
      )}{' '}
      {busy === kind ? progress[kind] : text}
    </button>
  );
  return (
    <aside className="detail" aria-label="Job details">
      <div className="detail-toolbar">
        <span>
          <Icon name="box" /> Delivery details
        </span>
        <button className="icon-button" aria-label="Close" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      {jobRead.loading && (
        <>
          <p role="status">Loading job…</p>
          <Skeleton rows={5} />
        </>
      )}
      {jobRead.error && <ErrorBox error={jobRead.error} retry={jobRead.reload} />}
      {job && (
        <>
          <div className="job-heading">
            <div>
              <span className="section-kicker">DELIVERY ORDER</span>
              <h2>{job.orderReference}</h2>
            </div>
            <Badge value={job.status} />
          </div>
          <div className="detail-tabs" aria-label="Job detail views">
            <button aria-pressed={view === 'overview'} onClick={() => setView('overview')}>
              Overview
            </button>
            <button aria-pressed={view === 'activity'} onClick={() => setView('activity')}>
              Activity & history <span>{history.data?.pagination.total ?? '—'}</span>
            </button>
          </div>
          <div hidden={view !== 'overview'}>
            <div className="route-card">
              <span className="route-node pickup" />
              <div>
                <small>Pickup</small>
                <strong>{titleCase(job.pickupZone)}</strong>
              </div>
              <Icon name="arrow" size={22} />
              <span className="route-node" />
              <div>
                <small>Delivery</small>
                <strong>{titleCase(job.deliveryZone)}</strong>
              </div>
            </div>
            <dl className="job-facts">
              <div>
                <dt>Load requirement</dt>
                <dd>
                  <Icon name="box" />
                  {job.loadUnits} units
                </dd>
              </div>
              <div>
                <dt>Priority</dt>
                <dd>
                  <span className={`priority-dot ${job.priority.toLowerCase()}`} />
                  {titleCase(job.priority)}
                </dd>
              </div>
              <div>
                <dt>Received</dt>
                <dd>{date(job.createdAt)}</dd>
              </div>
              <div>
                <dt>Delivery deadline</dt>
                <dd>{date(job.deadlineAt)}</dd>
              </div>
            </dl>
            <div className="assigned-rider">
              <span className="avatar">
                {job.assignedRiderId ? (
                  initials(riderName(job.assignedRiderId))
                ) : (
                  <Icon name="riders" />
                )}
              </span>
              <div>
                <small>Assigned rider</small>
                <strong>
                  {job.assignedRiderId ? riderName(job.assignedRiderId) : 'Not assigned yet'}
                </strong>
              </div>
            </div>
            {stateIndex >= 0 && (
              <ol className="lifecycle" aria-label="Delivery progress">
                {['Created', 'Ready', 'Assigned', 'Accepted', 'Picked up', 'Delivered'].map(
                  (step, i) => (
                    <li
                      key={step}
                      className={i < stateIndex ? 'complete' : i === stateIndex ? 'current' : ''}
                      aria-current={i === stateIndex ? 'step' : undefined}
                    >
                      <span>{i < stateIndex ? <Icon name="check" size={11} /> : i + 1}</span>
                      <small>{step}</small>
                    </li>
                  ),
                )}
              </ol>
            )}
            {job.manualReason && (
              <div className="manual-callout">
                <Icon name="alert" />
                <div>
                  <strong>Dispatcher intervention required</strong>
                  <p>
                    {titleCase(job.manualReason)}. Review the retained attempt and choose the next
                    eligible rider.
                  </p>
                  <button className="text-button" onClick={() => setView('activity')}>
                    Investigate history <Icon name="arrow" size={14} />
                  </button>
                </div>
              </div>
            )}
            {terminal ? (
              <div className={`terminal-state ${job.status === 'CANCELLED' ? 'cancelled' : ''}`}>
                <Icon name={job.status === 'DELIVERED' ? 'check' : 'close'} size={25} />
                <h3>{job.status === 'DELIVERED' ? 'Delivery completed' : 'Delivery cancelled'}</h3>
                <p>
                  {job.status === 'DELIVERED'
                    ? 'The delivery is complete and its reserved capacity has been released.'
                    : 'This job is closed. Its cancellation reason and prior attempts remain in history.'}
                </p>
              </div>
            ) : (
              <fieldset disabled={disabled} className="action-card">
                <legend>Next action</legend>
                <div className="action-intro">
                  <Icon name={canRecommend ? 'spark' : 'activity'} />
                  <p>
                    {job.status === 'NEW'
                      ? 'Ready to dispatch? Mark this job ready before reviewing riders.'
                      : canRecommend
                        ? 'Review eligible riders and make an informed assignment.'
                        : job.status === 'AWAITING_CONFIRMATION'
                          ? 'Waiting for the assigned rider. Use the controls below to simulate their response.'
                          : job.status === 'ACCEPTED'
                            ? 'The rider has accepted. Record pickup when the delivery is collected.'
                            : 'Pickup is recorded. Complete the delivery when it reaches the destination.'}
                  </p>
                </div>
                <div className="action-buttons">
                  {job.status === 'NEW' && button('ready', 'Mark ready')}
                  {canRecommend && (
                    <button className="primary" onClick={() => void mutate('recommend', recommend)}>
                      <Icon
                        name={busy === 'recommend' ? 'loader' : 'spark'}
                        className={busy === 'recommend' ? 'spin' : ''}
                      />
                      {busy === 'recommend' ? 'Evaluating riders…' : 'Review recommendations'}
                    </button>
                  )}
                  {job.status === 'AWAITING_CONFIRMATION' && (
                    <>
                      {button('accept', 'Accept assignment')}
                      {button('reject', 'Reject assignment', false, true)}
                    </>
                  )}
                  {job.status === 'ACCEPTED' && button('pickup', 'Record pickup')}
                  {job.status === 'PICKED_UP' && button('deliver', 'Complete delivery')}
                </div>
                {job.status !== 'PICKED_UP' && (
                  <label className="reason-field">
                    Operational reason
                    <textarea
                      aria-label="Operational reason"
                      aria-describedby="operational-reason-help"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      maxLength={500}
                      placeholder="Add a reason for an override, rejection or cancellation"
                    />
                    <small id="operational-reason-help">
                      Required for those actions. {reason.length}/500 characters.
                    </small>
                  </label>
                )}
                {job.status !== 'PICKED_UP' && (
                  <div className="cancel-row">
                    <span>Cancel before pickup if the delivery is no longer needed.</span>
                    {button('cancel', 'Cancel job', false, true)}
                  </div>
                )}
              </fieldset>
            )}
            {busy && (
              <div className="action-progress" role="status">
                <Icon name="loader" className="spin" />
                <div>
                  <strong>{progress[busy]}</strong>
                  <small>Waiting for the server to confirm the outcome.</small>
                </div>
              </div>
            )}
            {notice && (
              <div className="inline-success">
                <Icon name="check" />
                <span>{notice}</span>
              </div>
            )}
            {error && <ErrorBox error={error} />}
            {command && !busy && (
              <div className="warning">
                <Icon name="alert" />
                <div>
                  <strong>Assignment outcome needs confirmation</strong>
                  <p>
                    The response was not confirmed. Recover the saved command before making a new
                    assignment.
                  </p>
                  <button onClick={() => void mutate('retry', () => assign(command))}>
                    Retry exact assignment <Icon name="refresh" size={15} />
                  </button>
                </div>
              </div>
            )}
            {snapshot && canRecommend && (
              <section
                ref={recommendationAnchor}
                className="recommendations"
                aria-label="Rider recommendations"
              >
                <div className="subsection-heading">
                  <div>
                    <span className="section-kicker">DISPATCH INTELLIGENCE</span>
                    <h3>Recommended riders</h3>
                  </div>
                  <span className="count-pill">{snapshot.eligible.length} eligible</span>
                </div>
                <p className="section-description">
                  Lowest cost ranks first. Capacity is checked again when you assign.
                </p>
                {!snapshot.eligible.length && (
                  <Empty
                    title="No eligible riders. The job is available in the manual queue."
                    description="Review coverage, availability or free capacity, then evaluate again."
                  />
                )}
                <fieldset disabled={disabled || !!command}>
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
                      <div className="candidate-content">
                        <div className="candidate-top">
                          <span className="avatar">{initials(riderName(r.riderId))}</span>
                          <div>
                            <strong>{riderName(r.riderId)}</strong>
                            <small>
                              {r.rank === 1
                                ? 'Recommended · best score'
                                : `Rank #${r.rank} · eligible alternative`}
                            </small>
                          </div>
                          <div className="candidate-cost">
                            <strong>{r.totalCost}</strong>
                            <small>total cost</small>
                          </div>
                        </div>
                        <div className="candidate-stats">
                          <span>
                            <Icon name="clock" size={14} />
                            {r.estimatedMinutes} min estimated
                          </span>
                          <span>{r.availableUnits} free units</span>
                          <span>{r.activeJobCount} active</span>
                        </div>
                        <div className="score-breakdown">
                          <span>
                            Travel <b>{r.breakdown.travelCost}</b>
                          </span>
                          <span>
                            Workload <b>{r.breakdown.workloadCost}</b>
                          </span>
                          <span>
                            Deadline <b>{r.breakdown.deadlineCost}</b>
                          </span>
                        </div>
                        <span className="sr-only">
                          Travel {r.breakdown.travelCost} + workload {r.breakdown.workloadCost} +
                          deadline {r.breakdown.deadlineCost}
                        </span>
                        <details className="score-reasons">
                          <summary>Why this rider?</summary>
                          <p>
                            {r.reasons.join(' · ')}
                            {r.estimatedByFallback ? ' · Conservative fallback estimate' : ''}
                          </p>
                        </details>
                      </div>
                    </label>
                  ))}
                  {!!snapshot.eligible.length && (
                    <>
                      <p className="override-hint">
                        {chosen !== snapshot.eligible[0]?.riderId
                          ? 'Choosing an alternative? Add an operational reason above to continue.'
                          : 'The top-ranked eligible rider is selected. You can choose another with a reason.'}
                      </p>
                      <button
                        className="primary full-width"
                        disabled={
                          !chosen || (chosen !== snapshot.eligible[0]?.riderId && !reason.trim())
                        }
                        onClick={() => void mutate('assign', () => assign())}
                      >
                        <Icon
                          name={busy === 'assign' ? 'loader' : 'arrow'}
                          className={busy === 'assign' ? 'spin' : ''}
                        />
                        {busy === 'assign'
                          ? 'Assigning rider…'
                          : job.status === 'MANUAL_QUEUE'
                            ? 'Reassign selected rider'
                            : 'Assign selected rider'}
                      </button>
                    </>
                  )}
                </fieldset>
                <details className="excluded">
                  <summary>
                    <Icon name="shield" size={15} /> Excluded riders ({snapshot.excluded.length})
                  </summary>
                  {snapshot.excluded.map((r) => (
                    <div key={r.riderId}>
                      <strong>{riderName(r.riderId)}</strong>
                      <p>{r.reasons.map(titleCase).join(' · ')}</p>
                    </div>
                  ))}
                </details>
                <p className="scoring-meta">
                  Scoring {snapshot.scoringVersion} · evaluated {date(snapshot.generatedAt)}
                </p>
              </section>
            )}
          </div>
          <JobHistory
            history={history}
            page={page}
            changePage={setPage}
            riderName={riderName}
            active={view === 'activity'}
          />
        </>
      )}
    </aside>
  );
}
