import { Icon, type IconName } from './Icon';
import { date, label, titleCase } from './shared';
import { statuses, zones, type Dashboard, type JobStatus, type Page, type Rider } from './types';
export function Overview({
  data,
  loading,
  fleet,
  zone,
  setZone,
  deliveries,
  manual,
  riders,
  openJob,
}: {
  data: Dashboard['data'] | undefined;
  loading: boolean;
  fleet: Page<Rider> | undefined;
  zone: string;
  setZone: (zone: string) => void;
  deliveries: (status?: JobStatus) => void;
  manual: () => void;
  riders: () => void;
  openJob: (id: string) => void;
}) {
  const metrics: {
    title: string;
    value: number | undefined;
    icon: IconName;
    hint: string;
    tone?: string;
  }[] = [
    { title: 'Total deliveries', value: data?.total, icon: 'box', hint: 'All jobs received' },
    {
      title: 'Awaiting dispatch',
      value: data?.awaitingAssignment,
      icon: 'clock',
      hint: 'New & ready to assign',
    },
    {
      title: 'Awaiting response',
      value: data?.byStatus.AWAITING_CONFIRMATION,
      icon: 'riders',
      hint: 'Capacity reserved',
    },
    { title: 'In progress', value: data?.inProgress, icon: 'truck', hint: 'Accepted & picked up' },
    {
      title: 'Manual queue',
      value: data?.byStatus.MANUAL_QUEUE,
      icon: 'alert',
      hint: 'Dispatcher action needed',
      tone: 'amber',
    },
    {
      title: 'Delivered',
      value: data?.byStatus.DELIVERED,
      icon: 'check',
      hint: 'Successfully completed',
      tone: 'green',
    },
    {
      title: 'Cancelled',
      value: data?.byStatus.CANCELLED,
      icon: 'close',
      hint: 'Closed deliveries',
    },
  ];
  const people = fleet?.data;
  return (
    <section aria-label="Dispatch overview">
      <div className="overview-controls">
        <p>A live summary of your dispatch operation.</p>
        <label>
          Overview zone
          <select value={zone} onChange={(e) => setZone(e.target.value)}>
            <option value="">All zones</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {titleCase(z)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <section aria-label="Workload overview" className="metrics" aria-busy={loading}>
        {metrics.map((m) => (
          <article className={`metric ${m.tone ?? ''}`} key={m.title}>
            <div className="metric-top">
              <span>{m.title}</span>
              <Icon name={m.icon} size={16} />
            </div>
            {m.value === undefined ? (
              <span className="metric-placeholder" />
            ) : (
              <strong>{m.value.toLocaleString()}</strong>
            )}
            <small>{m.hint}</small>
          </article>
        ))}
      </section>
      <div className="sync-note">
        <span>
          {loading
            ? 'Loading workload…'
            : data
              ? `Last synced ${new Date(data.asOf).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · Updates every 5 seconds`
              : 'Workload unavailable'}
        </span>
        <span>
          <Icon name="shield" size={13} /> Delivery actions are audited
        </span>
      </div>
      <section
        className={`attention-panel ${data?.attentionTotal === 0 ? 'all-clear' : ''}`}
        aria-label="Needs attention"
      >
        <div className="attention-heading">
          <span className="attention-icon">
            <Icon name={data?.attentionTotal === 0 ? 'check' : 'alert'} size={19} />
          </span>
          <div>
            <h2>
              {data?.attentionTotal === 0
                ? 'You’re all caught up.'
                : 'A little attention goes a long way.'}
            </h2>
            <p>
              {data
                ? `${data.attentionTotal} deliveries need attention. Review exceptions and overdue work.`
                : 'Checking for deliveries that need intervention…'}
            </p>
          </div>
          <button className="text-button" onClick={manual}>
            Review manual queue <Icon name="arrow" size={15} />
          </button>
        </div>
        {!!data?.attention.length && (
          <div className="attention-links">
            {data.attention.slice(0, 5).map((j) => (
              <button
                key={j.id}
                aria-label={`Open ${j.orderReference}: ${label(j.attentionReason)}`}
                onClick={() => openJob(j.id)}
              >
                <span>
                  <strong>{j.orderReference}</strong>
                  <small>
                    {titleCase(j.attentionReason)} · {date(j.createdAt)}
                  </small>
                </span>
                <Icon name="chevron" size={14} />
              </button>
            ))}
            {data.attentionTotal > 5 && (
              <span className="more-attention">+{data.attentionTotal - 5} more in the queues</span>
            )}
          </div>
        )}
      </section>
      <div className="overview-grid">
        <section className="panel overview-card" aria-label="Delivery status breakdown">
          <div className="overview-card-heading">
            <div>
              <span className="section-kicker">DELIVERY FLOW</span>
              <h2>Where things stand</h2>
            </div>
            <button className="text-button" onClick={() => deliveries()}>
              View deliveries <Icon name="arrow" size={15} />
            </button>
          </div>
          <div className="status-breakdown">
            {statuses.map((status) => (
              <button
                key={status}
                onClick={() => (status === 'MANUAL_QUEUE' ? manual() : deliveries(status))}
                aria-label={`Show ${label(status)} deliveries`}
              >
                <span>{titleCase(status)}</span>
                <span className="status-track" aria-hidden="true">
                  <i
                    style={{
                      width: `${data?.total ? (100 * (data.byStatus[status] ?? 0)) / data.total : 0}%`,
                    }}
                  />
                </span>
                <strong>{data ? (data.byStatus[status] ?? 0) : '—'}</strong>
                <Icon name="chevron" size={13} />
              </button>
            ))}
          </div>
        </section>
        <section className="panel overview-card" aria-label="Fleet snapshot">
          <div className="overview-card-heading">
            <div>
              <span className="section-kicker">YOUR RIDERS</span>
              <h2>Fleet at a glance</h2>
            </div>
            <button className="text-button" onClick={riders}>
              View riders <Icon name="arrow" size={15} />
            </button>
          </div>
          <p className="section-description">
            Across all service zones
            {fleet && fleet.pagination.total > fleet.data.length
              ? ` · Showing ${fleet.data.length} of ${fleet.pagination.total} riders`
              : ''}
            .
          </p>
          <dl className="fleet-summary">
            <div>
              <dt>Available for new work</dt>
              <dd>{people ? people.filter((r) => r.availability === 'AVAILABLE').length : '—'}</dd>
            </div>
            <div>
              <dt>Unavailable</dt>
              <dd>
                {people ? people.filter((r) => r.availability === 'UNAVAILABLE').length : '—'}
              </dd>
            </div>
            <div>
              <dt>Free capacity units</dt>
              <dd>{people ? people.reduce((n, r) => n + r.availableUnits, 0) : '—'}</dd>
            </div>
            <div>
              <dt>Reserved capacity units</dt>
              <dd>{people ? people.reduce((n, r) => n + r.reservedUnits, 0) : '—'}</dd>
            </div>
          </dl>
          <p className="overview-footnote">
            Availability, coverage and remaining capacity are checked again when you assign.
          </p>
        </section>
      </div>
    </section>
  );
}
