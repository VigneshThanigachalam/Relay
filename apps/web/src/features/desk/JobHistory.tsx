import { Icon } from './Icon';
import { Badge, date, ErrorBox, label, Pager, Skeleton, titleCase } from './shared';
import type { Event, History } from './types';
function eventDescription(event: Event) {
  const d = event.details;
  if (typeof d.reason === 'string') return titleCase(d.reason);
  if (typeof d.releasedUnits === 'number') return `${d.releasedUnits} capacity units released`;
  if (typeof d.to === 'string') return `Moved to ${label(d.to)}`;
  if (typeof d.expiresAt === 'string') return `Confirmation due ${date(d.expiresAt)}`;
  if (event.type === 'JOB_CREATED')
    return `${String(d.pickupZone)} → ${String(d.deliveryZone)} · ${String(d.loadUnits)} units`;
  if (event.type === 'RIDERS_RECOMMENDED')
    return 'Eligibility checked and scoring snapshot recorded';
  return 'Recorded in the operational history';
}
export function JobHistory({
  history,
  page,
  changePage,
  riderName,
  active,
}: {
  history: {
    data: History | undefined;
    error: string | undefined;
    loading: boolean;
    reload: () => void;
  };
  page: number;
  changePage: (page: number) => void;
  riderName: (id: string) => string;
  active: boolean;
}) {
  return (
    <section className="history-section" aria-label="Operational history" hidden={!active}>
      <div className="subsection-heading">
        <h3>Operational history</h3>
        <span className="audit-label">
          <Icon name="shield" size={14} /> Append-only
        </span>
      </div>
      {history.loading && <Skeleton />}
      {history.error && <ErrorBox error={history.error} retry={history.reload} />}
      {history.data && (
        <>
          <h4>Assignment attempts</h4>
          {!history.data.data.attempts.length && (
            <p className="section-description">
              No assignment attempts yet. Your first dispatch will appear here.
            </p>
          )}
          {history.data.data.attempts.map((a, i) => (
            <details key={a.id} className="attempt">
              <summary>
                <span className="attempt-number">{(page - 1) * 20 + i + 1}</span>
                <span>
                  <strong>{riderName(a.riderId)}</strong>
                  <small>
                    {a.loadUnits} units · {date(a.assignedAt)}
                  </small>
                </span>
                <Badge value={a.status} />
              </summary>
              <dl className="attempt-facts">
                <div>
                  <dt>Confirmation deadline</dt>
                  <dd>{date(a.expiresAt)}</dd>
                </div>
                <div>
                  <dt>Capacity</dt>
                  <dd>
                    {a.reservationReleasedAt
                      ? `Released ${date(a.reservationReleasedAt)}`
                      : 'Reserved for this attempt'}
                  </dd>
                </div>
                {a.endReason && (
                  <div>
                    <dt>Outcome reason</dt>
                    <dd>{titleCase(a.endReason)}</dd>
                  </div>
                )}
                {a.overrideReason && (
                  <div>
                    <dt>Override / note</dt>
                    <dd>{a.overrideReason}</dd>
                  </div>
                )}
              </dl>
              <details className="raw-details">
                <summary>Stored scoring snapshot</summary>
                <pre>{JSON.stringify(a.recommendationSnapshot, null, 2)}</pre>
              </details>
            </details>
          ))}
          <h4>Chronological activity</h4>
          <ol className="timeline">
            {history.data.data.events.map((e) => (
              <li key={e.id}>
                <span
                  className={`event-icon ${e.type === 'ASSIGNMENT_FAILED' ? 'event-error' : ''}`}
                >
                  <Icon
                    name={
                      e.type.includes('FAILED') ||
                      e.type.includes('EXPIRED') ||
                      e.type.includes('REJECTED')
                        ? 'alert'
                        : e.type === 'RIDERS_RECOMMENDED'
                          ? 'spark'
                          : e.type.includes('DELIVERED') || e.type.includes('ACCEPTED')
                            ? 'check'
                            : 'activity'
                    }
                    size={14}
                  />
                </span>
                <div>
                  <strong>{titleCase(e.type)}</strong>
                  <p>{eventDescription(e)}</p>
                  <small>
                    #{e.sequence} · {date(e.occurredAt)} · {e.actor}
                  </small>
                  <details className="raw-details">
                    <summary>Event details</summary>
                    <pre>{JSON.stringify(e.details, null, 2)}</pre>
                  </details>
                </div>
              </li>
            ))}
          </ol>
          <Pager
            pagination={{
              ...history.data.pagination,
              total: Math.max(history.data.pagination.total, history.data.attemptsPagination.total),
            }}
            change={changePage}
          />
        </>
      )}
    </section>
  );
}
