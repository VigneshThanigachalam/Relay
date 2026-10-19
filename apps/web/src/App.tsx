import { QueueTable } from './features/desk/QueueTable';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useResource } from './features/desk/api';
import { Notifications, useNotify } from './features/desk/feedback';
import { Icon, type IconName } from './features/desk/Icon';
import { JobForm, RiderForm } from './features/desk/forms';
import { JobDetail } from './features/desk/JobDetail';
import { RiderDetail } from './features/desk/RiderDetail';
import { Sheet } from './features/desk/Sheet';
import { Empty, ErrorBox, label, Pager, Skeleton, titleCase } from './features/desk/shared';
import {
  statuses,
  zones,
  type Dashboard,
  type Job,
  type ManualJob,
  type Page,
  type Rider,
} from './features/desk/types';
type View = 'overview' | 'jobs' | 'manual' | 'riders';
type Panel = { kind: 'job' | 'rider'; id: string } | { kind: 'new-job' | 'new-rider' };
const nav: { view: View; title: string; icon: IconName }[] = [
  { view: 'overview', title: 'Overview', icon: 'grid' },
  { view: 'jobs', title: 'Deliveries', icon: 'box' },
  { view: 'manual', title: 'Manual queue', icon: 'alert' },
  { view: 'riders', title: 'Riders', icon: 'riders' },
];
export function App() {
  return (
    <Notifications>
      <Desk />
    </Notifications>
  );
}
function Desk() {
  const [view, setView] = useState<View>('overview'),
    [zone, setZone] = useState(''),
    [status, setStatus] = useState(''),
    [search, setSearch] = useState(''),
    [draft, setDraft] = useState('');
  const [page, setPage] = useState(1),
    [revision, setRevision] = useState(0),
    [manualRefresh, setManualRefresh] = useState<number | null>(null),
    [panel, setPanel] = useState<Panel | null>(null);
  const notify = useNotify();
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const collection = view === 'manual' ? 'manual-queue' : view === 'riders' ? 'riders' : 'jobs';
  const query = new URLSearchParams({
    page: String(page),
    pageSize: '20',
    ...(zone ? { zone } : {}),
    ...(collection === 'jobs' && status ? { status } : {}),
    ...(search && collection !== 'manual-queue'
      ? collection === 'riders'
        ? { code: search }
        : { orderReference: search }
      : {}),
  });
  const dashboard = useResource<Dashboard>(
    `/dashboard${zone ? `?zone=${zone}` : ''}`,
    revision,
    'dashboard',
  );
  const rows = useResource<Page<Job | ManualJob | Rider>>(
    `/${collection}?${query}`,
    revision,
    collection,
  );
  const fleet = useResource<Page<Rider>>('/riders?pageSize=100', revision);
  const data = dashboard.data?.data;
  useEffect(() => {
    if (
      manualRefresh === null ||
      [dashboard.settledRevision, rows.settledRevision, fleet.settledRevision].some(
        (n) => n < manualRefresh,
      )
    )
      return;
    const failed = dashboard.error || rows.error || fleet.error;
    notify({
      type: failed ? 'error' : 'success',
      title: failed ? 'Some data could not refresh' : 'Workspace is up to date',
      description: failed
        ? 'The last successful data remains visible. Retry the affected read.'
        : 'Latest delivery states and rider capacity are now visible.',
    });
    setManualRefresh(null);
  }, [
    manualRefresh,
    dashboard.settledRevision,
    rows.settledRevision,
    fleet.settledRevision,
    dashboard.error,
    rows.error,
    fleet.error,
    notify,
  ]);
  function switchView(next: View) {
    setView(next);
    setPage(1);
    setSearch('');
    setDraft('');
    setStatus('');
  }
  function openJob(id: string) {
    setPanel({ kind: 'job', id });
  }
  function submitSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSearch(draft.trim());
    setPage(1);
  }
  function clearFilters() {
    setSearch('');
    setDraft('');
    setStatus('');
    setZone('');
    setPage(1);
  }
  const selectedId = panel && 'id' in panel ? panel.id : null;
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
  const filtersActive = !!(zone || status || search);
  return (
    <div className="app-layout">
      <a className="skip-link" href="#desk-content">
        Skip to deliveries
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-symbol">
            <Icon name="truck" size={22} />
          </span>
          <div>
            <strong>
              relay<span>.</span>
            </strong>
            <small>THE DISPATCH DESK</small>
          </div>
        </div>
        <div className="workspace-label">
          <span className="workspace-symbol">R</span>
          <div>
            <strong>Operations workspace</strong>
            <small>Local demonstration</small>
          </div>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {nav.map((n) => (
            <button
              key={n.view}
              className={view === n.view ? 'nav-item active' : 'nav-item'}
              aria-current={view === n.view ? 'page' : undefined}
              onClick={() => switchView(n.view)}
            >
              <Icon name={n.icon} />
              <span>{n.title}</span>
              {n.view === 'manual' && !!data?.byStatus.MANUAL_QUEUE && (
                <b>{data.byStatus.MANUAL_QUEUE}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="status-dot" />
          <strong>Built for the next move.</strong>
          <p>
            Review. Assign. Deliver.
            <br />
            Keep every decision in view.
          </p>
        </div>
        <div className="workspace-user">
          <span className="avatar">OP</span>
          <div>
            <strong>Demo dispatcher</strong>
            <small>dispatcher:demo</small>
          </div>
          <span className="online-dot" />
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Operations</span>
            <Icon name="chevron" size={13} />
            <strong>{nav.find((n) => n.view === view)?.title}</strong>
          </div>
          <div className="topbar-right">
            <span className={`live-indicator ${dashboard.error ? 'disconnected' : ''}`}>
              <i />
              {dashboard.loading
                ? 'Connecting…'
                : dashboard.error
                  ? 'Connection needs attention'
                  : 'Live updates'}
            </span>
            <span className="topbar-divider" />
            <span className="local-date">
              {new Date().toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </span>
            <span className="avatar topbar-avatar">OP</span>
          </div>
        </header>
        <div className="mobile-nav" aria-label="Mobile navigation">
          {nav.map((n) => (
            <button
              key={n.view}
              aria-label={`Navigate to ${n.title}`}
              aria-pressed={view === n.view}
              onClick={() => switchView(n.view)}
            >
              <Icon name={n.icon} size={17} />
              <span>{n.title}</span>
            </button>
          ))}
        </div>
        <main id="desk-content">
          <div className="page-head">
            <div>
              <div className="page-eyebrow">
                <span className="status-dot" /> OPERATIONS AT A GLANCE
              </div>
              <h1>
                {view === 'riders'
                  ? 'Your fleet, in focus.'
                  : view === 'manual'
                    ? 'Make the next move.'
                    : 'Every delivery. One clear view.'}
              </h1>
              <p>
                {view === 'riders'
                  ? 'Manage coverage, availability and capacity across your riders.'
                  : view === 'manual'
                    ? 'Resolve exceptions with the full story behind every assignment.'
                    : 'Manage your delivery flow, from the first assignment to the final mile.'}
              </p>
            </div>
            <div className="head-actions">
              <button
                className="secondary"
                disabled={manualRefresh !== null}
                onClick={() => {
                  const next = revision + 1;
                  setManualRefresh(next);
                  setRevision(next);
                }}
              >
                <Icon name="refresh" className={manualRefresh !== null ? 'spin' : ''} />
                {manualRefresh !== null ? 'Refreshing…' : 'Refresh'}
              </button>
              <button
                className="primary"
                onClick={() => setPanel({ kind: view === 'riders' ? 'new-rider' : 'new-job' })}
              >
                <Icon name="plus" />
                {view === 'riders' ? 'Add rider' : 'New job'}
              </button>
            </div>
          </div>
          {dashboard.error && <ErrorBox error={dashboard.error} retry={dashboard.reload} />}
          <section aria-label="Workload overview" className="metrics" aria-busy={dashboard.loading}>
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
              {dashboard.loading ? (
                'Loading workload…'
              ) : data ? (
                <>
                  Last synced{' '}
                  {new Date(data.asOf).toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}{' '}
                  <i /> Updates every 5 seconds
                </>
              ) : (
                'Workload unavailable'
              )}
            </span>
            <span>
              <Icon name="shield" size={13} /> Delivery actions are audited
            </span>
          </div>
          {view !== 'riders' && (
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
                      ? `${data.attentionTotal} ${data.attentionTotal === 1 ? 'delivery needs' : 'deliveries need'} attention. ${data.attentionTotal ? 'Review exceptions and keep things moving.' : 'No manual intervention or overdue work right now.'}`
                      : 'Checking for deliveries that need intervention…'}
                  </p>
                </div>
                {!!data?.byStatus.MANUAL_QUEUE && (
                  <button className="text-button" onClick={() => switchView('manual')}>
                    Review manual queue <Icon name="arrow" size={15} />
                  </button>
                )}
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
                        <small>{titleCase(j.attentionReason)}</small>
                      </span>
                      <Icon name="chevron" size={14} />
                    </button>
                  ))}
                  {data.attentionTotal > 5 && (
                    <span className="more-attention">
                      +{data.attentionTotal - 5} more in the queues
                    </span>
                  )}
                </div>
              )}
            </section>
          )}
          <section className="panel queue" aria-label="Operational queues">
            <div className="queue-heading">
              <div>
                <div className="queue-title">
                  <h2>
                    {view === 'riders'
                      ? 'Rider directory'
                      : view === 'manual'
                        ? 'Manual queue'
                        : view === 'jobs'
                          ? 'All deliveries'
                          : 'Delivery queue'}
                  </h2>
                  {rows.data && <span className="count-pill">{rows.data.pagination.total}</span>}
                </div>
                <p>
                  {view === 'riders'
                    ? 'The right rider starts with an accurate view of their workload.'
                    : view === 'manual'
                      ? 'Retained attempts, clear reasons and a safe route to reassignment.'
                      : 'Your live delivery workload. Open any order to take the next step.'}
                </p>
              </div>
              <span className={`queue-sync ${rows.error ? 'failed' : ''}`}>
                <i />
                {rows.error ? 'Update unavailable' : rows.stale ? 'Updating view…' : 'Live queue'}
              </span>
            </div>
            <div className="filters">
              {view !== 'manual' && (
                <form onSubmit={submitSearch}>
                  <div className="search-field">
                    <Icon name="search" size={17} />
                    <label className="sr-only" htmlFor="queue-search">
                      {view === 'riders' ? 'Rider code' : 'Order reference'}
                    </label>
                    <input
                      id="queue-search"
                      name="search"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder={
                        view === 'riders'
                          ? 'Search by exact rider code'
                          : 'Search by order reference'
                      }
                    />
                    {draft && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Clear search text"
                        onClick={() => setDraft('')}
                      >
                        <Icon name="close" size={13} />
                      </button>
                    )}
                  </div>
                  <button className="search-submit">Search</button>
                </form>
              )}
              <div className="filter-controls">
                <label>
                  <span>Zone</span>
                  <select
                    value={zone}
                    onChange={(e) => {
                      setZone(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="">All zones</option>
                    {zones.map((z) => (
                      <option key={z} value={z}>
                        {titleCase(z)}
                      </option>
                    ))}
                  </select>
                </label>
                {collection === 'jobs' && (
                  <label>
                    <span>Status</span>
                    <select
                      value={status}
                      onChange={(e) => {
                        setStatus(e.target.value);
                        setPage(1);
                      }}
                    >
                      <option value="">All statuses</option>
                      {statuses.map((s) => (
                        <option key={s} value={s}>
                          {titleCase(s)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {filtersActive && (
                  <button className="clear-filters" onClick={clearFilters}>
                    <Icon name="close" size={13} />
                    Clear filters
                  </button>
                )}
              </div>
            </div>
            {collection === 'jobs' && (
              <div className="queue-chips" aria-label="Quick status filters">
                {[
                  ['', 'All deliveries'],
                  ['READY_FOR_ASSIGNMENT', 'Ready to assign'],
                  ['AWAITING_CONFIRMATION', 'Awaiting response'],
                  ['DELIVERED', 'Delivered'],
                ].map(([value, text]) => (
                  <button
                    key={text}
                    aria-pressed={status === value}
                    onClick={() => {
                      setStatus(value ?? '');
                      setPage(1);
                    }}
                  >
                    {text}
                  </button>
                ))}
              </div>
            )}
            {rows.error && (
              <ErrorBox
                error={`${rows.error}${rows.data ? ' · Showing the last successful results.' : ''}`}
                retry={rows.reload}
              />
            )}
            {fleet.error && view !== 'riders' && (
              <p className="fleet-note">
                Rider labels are temporarily unavailable. Delivery records remain accessible.
              </p>
            )}
            {rows.loading && (
              <>
                <p className="sr-only" role="status">
                  Loading {view === 'riders' ? 'riders' : 'deliveries'}…
                </p>
                <Skeleton rows={6} />
              </>
            )}
            {rows.data && (
              <>
                {!rows.data.data.length ? (
                  <Empty
                    title={`No ${view === 'manual' ? 'jobs in the manual queue' : view === 'riders' ? 'riders' : 'jobs'} match this view.`}
                    description={
                      filtersActive
                        ? 'Try another reference or clear your filters to see more results.'
                        : view === 'riders'
                          ? 'Add your first rider to start building your delivery team.'
                          : 'Create a delivery job to get started. New work will appear here.'
                    }
                  />
                ) : (
                  <QueueTable
                    items={rows.data.data}
                    view={view}
                    selectedId={selectedId}
                    riders={fleet.data?.data ?? []}
                    openJob={openJob}
                    openRider={(id) => setPanel({ kind: 'rider', id })}
                    stale={rows.stale}
                    refreshing={rows.refreshing}
                  />
                )}
                <Pager pagination={rows.data.pagination} change={setPage} />
              </>
            )}
          </section>
          <footer>
            <span>
              <span className="status-dot" /> RELAY · Operations made clearer
            </span>
            <span>Simulated zones & travel times · All times shown locally</span>
          </footer>
        </main>
      </div>
      {panel && (
        <Sheet
          key={panel.kind + ('id' in panel ? panel.id : '')}
          label={
            panel.kind === 'job'
              ? 'Delivery workspace'
              : panel.kind === 'rider'
                ? 'Rider workspace'
                : panel.kind === 'new-job'
                  ? 'Create a delivery'
                  : 'Add a rider'
          }
          close={() => setPanel(null)}
        >
          {panel.kind === 'job' ? (
            <JobDetail
              id={panel.id}
              revision={revision}
              changed={refresh}
              riders={fleet.data?.data ?? []}
              close={() => setPanel(null)}
            />
          ) : panel.kind === 'rider' ? (
            <RiderDetail
              id={panel.id}
              revision={revision}
              changed={refresh}
              openJob={openJob}
              close={() => setPanel(null)}
            />
          ) : (
            <>
              <div className="detail-toolbar">
                <span>
                  <Icon name={panel.kind === 'new-job' ? 'box' : 'riders'} />
                  {panel.kind === 'new-job' ? 'New delivery' : 'New rider'}
                </span>
                <button className="icon-button" aria-label="Close" onClick={() => setPanel(null)}>
                  <Icon name="close" />
                </button>
              </div>
              {panel.kind === 'new-job' ? (
                <JobForm open={openJob} done={refresh} />
              ) : (
                <RiderForm
                  done={() => {
                    setPanel(null);
                    refresh();
                  }}
                />
              )}
            </>
          )}
        </Sheet>
      )}
    </div>
  );
}
