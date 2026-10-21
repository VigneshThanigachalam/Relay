import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router';
import { Overview } from './features/desk/Overview';
import { useDeskLocation, viewPaths, type View } from './features/desk/navigation';
import { QueueTable } from './features/desk/QueueTable';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useResource } from './features/desk/api';
import { Notifications, useNotify } from './features/desk/feedback';
import { Icon, type IconName } from './features/desk/Icon';
import { JobForm, RiderForm } from './features/desk/forms';
import { JobDetail } from './features/desk/JobDetail';
import { RiderDetail } from './features/desk/RiderDetail';
import { Sheet } from './features/desk/Sheet';
import { Empty, ErrorBox, Pager, Skeleton, titleCase } from './features/desk/shared';
import {
  statuses,
  zones,
  type Dashboard,
  type Job,
  type ManualJob,
  type Page,
  type Rider,
} from './features/desk/types';
type Panel = { kind: 'job' | 'rider'; id: string } | { kind: 'new-job' | 'new-rider' };
const nav: { view: View; title: string; icon: IconName }[] = [
  { view: 'overview', title: 'Overview', icon: 'grid' },
  { view: 'jobs', title: 'Deliveries', icon: 'box' },
  { view: 'manual', title: 'Manual queue', icon: 'alert' },
  { view: 'riders', title: 'Riders', icon: 'riders' },
];
export function App() {
  return (
    <BrowserRouter>
      <Notifications>
        <Routes>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          {nav.map(({ view }) => (
            <Route key={view} path={viewPaths[view]} element={<Desk view={view} />} />
          ))}
          <Route
            path="*"
            element={
              <div className="not-found">
                <h1>Page not found</h1>
                <NavLink to="/overview">Return to overview</NavLink>
              </div>
            }
          />
        </Routes>
      </Notifications>
    </BrowserRouter>
  );
}
function Desk({ view }: { view: View }) {
  const [location, navigate] = useDeskLocation(view);
  const { zone, status, search, page } = location;
  const [draft, setDraft] = useState(search);
  const [revision, setRevision] = useState(0);
  const [manualRefresh, setManualRefresh] = useState<{
    revision: number;
    startedAt: number;
  } | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const notify = useNotify();
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const collection = view === 'manual' ? 'manual-queue' : view === 'riders' ? 'riders' : 'jobs';
  const query = new URLSearchParams({
    page: String(page),
    pageSize: '20',
    ...(zone ? { zone } : {}),
    ...(collection === 'jobs' && status ? { status } : {}),
    ...(search && collection !== 'manual-queue' ? { search } : {}),
  });
  const dashboard = useResource<Dashboard>(
    `/dashboard${zone ? `?zone=${zone}` : ''}`,
    revision,
    'dashboard',
  );
  const rows = useResource<Page<Job | ManualJob | Rider>>(
    view === 'overview' ? null : `/${collection}?${query}`,
    revision,
    collection,
  );
  const fleet = useResource<Page<Rider>>('/riders?pageSize=100', revision);
  const data = dashboard.data?.data;
  useEffect(() => {
    setDraft(search);
  }, [view, search]);
  useEffect(() => {
    if (view === 'overview' || view === 'manual' || draft.trim() === search) return;
    const timer = setTimeout(() => navigate({ search: draft.trim(), page: 1 }, true), 350);
    return () => clearTimeout(timer);
  }, [draft, search, view, navigate]);
  useEffect(() => {
    document.title = `RELAY · ${nav.find((n) => n.view === view)?.title}`;
  }, [view]);
  useEffect(() => {
    if (
      !manualRefresh ||
      [dashboard.settledRevision, rows.settledRevision, fleet.settledRevision].some(
        (n) => n < manualRefresh.revision,
      )
    )
      return;
    // Hold only the feedback for one second. Real results can update immediately;
    // slow/failed requests still determine when this refresh actually settles.
    const timer = setTimeout(
      () => {
        const failed = dashboard.error || rows.error || fleet.error;
        notify({
          type: failed ? 'error' : 'success',
          title: failed ? 'Some data could not refresh' : 'Workspace is up to date',
          description: failed
            ? 'The last successful data remains visible. Retry the affected read.'
            : 'Latest delivery states and rider capacity are now visible.',
        });
        setManualRefresh(null);
      },
      Math.max(0, 1000 - (performance.now() - manualRefresh.startedAt)),
    );
    return () => clearTimeout(timer);
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
    navigate({ view: next, page: 1, search: '', status: '' });
    setPanel(null);
  }
  function openJob(id: string) {
    setPanel({ kind: 'job', id });
  }
  function submitSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    navigate({ search: draft.trim(), page: 1 }, true);
  }
  function clearFilters() {
    setDraft('');
    navigate({ zone: '', status: '', search: '', page: 1 });
  }
  const selectedId = panel && 'id' in panel ? panel.id : null;
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
            <NavLink
              key={n.view}
              to={{ pathname: viewPaths[n.view], search: zone ? `?zone=${zone}` : '' }}
              className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
              onClick={() => setPanel(null)}
            >
              <Icon name={n.icon} />
              <span>{n.title}</span>
              {n.view === 'manual' && !!data?.byStatus.MANUAL_QUEUE && (
                <b>{data.byStatus.MANUAL_QUEUE}</b>
              )}
            </NavLink>
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
            <NavLink
              key={n.view}
              to={{ pathname: viewPaths[n.view], search: zone ? `?zone=${zone}` : '' }}
              aria-label={`Navigate to ${n.title}`}
              onClick={() => setPanel(null)}
            >
              <Icon name={n.icon} size={17} />
              <span>{n.title}</span>
            </NavLink>
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
                    : view === 'jobs'
                      ? 'All deliveries, ready to move.'
                      : 'Your dispatch day, in focus.'}
              </h1>
              <p>
                {view === 'riders'
                  ? 'Manage coverage, availability and capacity across your riders.'
                  : view === 'manual'
                    ? 'Resolve exceptions with the full story behind every assignment.'
                    : view === 'jobs'
                      ? 'Search, filter and progress every delivery from one operational queue.'
                      : 'See the workload, spot exceptions and choose your next move.'}
              </p>
            </div>
            <div className="head-actions">
              <button
                className="secondary"
                disabled={manualRefresh !== null}
                onClick={() => {
                  const next = revision + 1;
                  setManualRefresh({ revision: next, startedAt: performance.now() });
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
          {view === 'overview' && (
            <>
              {fleet.error && <ErrorBox error={fleet.error} retry={fleet.reload} />}
              <Overview
                data={data}
                loading={dashboard.loading}
                fleet={fleet.data}
                zone={zone}
                setZone={(zone) => navigate({ zone, page: 1 })}
                deliveries={(status) =>
                  navigate({ view: 'jobs', status: status ?? '', search: '', page: 1 })
                }
                manual={() => switchView('manual')}
                riders={() => switchView('riders')}
                openJob={openJob}
              />
            </>
          )}
          {view !== 'overview' && (
            <>
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
                      {rows.data && (
                        <span className="count-pill">{rows.data.pagination.total}</span>
                      )}
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
                    {rows.error
                      ? 'Update unavailable'
                      : rows.stale || draft.trim() !== search
                        ? 'Searching / updating…'
                        : 'Live queue'}
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
                          type="search"
                          maxLength={view === 'riders' ? 100 : 80}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          placeholder={
                            view === 'riders'
                              ? 'Search rider name or code'
                              : 'Search by order reference'
                          }
                        />
                        {draft && (
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="Clear search text"
                            onClick={() => {
                              setDraft('');
                              navigate({ search: '', page: 1 }, true);
                            }}
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
                        aria-label="Zone"
                        value={zone}
                        onChange={(e) => {
                          navigate({ zone: e.target.value, page: 1 });
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
                          aria-label="Status"
                          value={status}
                          onChange={(e) => {
                            navigate({ status: e.target.value, page: 1 });
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
                          navigate({ status: value ?? '', page: 1 });
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
                    <Pager
                      pagination={rows.data.pagination}
                      change={(page) => navigate({ page })}
                    />
                  </>
                )}
              </section>
            </>
          )}
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
