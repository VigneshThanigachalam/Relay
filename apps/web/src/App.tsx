import { useState, type FormEvent } from 'react';
import { useResource } from './features/desk/api';
import { JobForm, RiderForm } from './features/desk/forms';
import { JobDetail } from './features/desk/JobDetail';
import { RiderDetail } from './features/desk/RiderDetail';
import { Badge, date, ErrorBox, label, Pager } from './features/desk/shared';
import {
  statuses,
  zones,
  type Dashboard,
  type Job,
  type ManualJob,
  type Page,
  type Rider,
} from './features/desk/types';
export function App() {
  const [tab, setTab] = useState<'jobs' | 'manual' | 'riders'>('jobs');
  const [zone, setZone] = useState(''),
    [status, setStatus] = useState(''),
    [search, setSearch] = useState('');
  const [page, setPage] = useState(1),
    [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<{ kind: 'job' | 'rider'; id: string } | null>(null);
  const [form, setForm] = useState<'job' | 'rider' | null>(null);
  const refresh = () => setRevision((n) => n + 1);
  const query = new URLSearchParams({
    page: String(page),
    pageSize: '20',
    ...(zone ? { zone } : {}),
    ...(tab === 'jobs' && status ? { status } : {}),
    ...(search
      ? tab === 'jobs'
        ? { orderReference: search }
        : tab === 'riders'
          ? { code: search }
          : {}
      : {}),
  });
  const dashboard = useResource<Dashboard>(`/dashboard${zone ? `?zone=${zone}` : ''}`, revision);
  const jobs = useResource<Page<ManualJob | Job | Rider>>(
    `/${tab === 'manual' ? 'manual-queue' : tab}?${query}`,
    revision,
  );
  const fleet = useResource<Page<Rider>>('/riders?pageSize=100', revision);
  function switchTab(next: typeof tab) {
    setTab(next);
    setPage(1);
    setSearch('');
    setStatus('');
  }
  function openJob(id: string) {
    setSelection({ kind: 'job', id });
    setForm(null);
  }
  function submitSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSearch(String(new FormData(e.currentTarget).get('search') ?? '').trim());
    setPage(1);
  }
  const data = dashboard.data?.data;
  return (
    <div className="desk">
      <header className="topbar">
        <a className="brand" href="#">
          R<span>↗</span> <strong>RELAY</strong>
        </a>
        <span className="product-name">Autonomous Dispatch Desk</span>
        <span className="demo-actor">Demo · dispatcher:demo</span>
      </header>
      <main>
        <div className="page-head">
          <div>
            <p className="eyebrow">OPERATIONS / LIVE WORKLOAD</p>
            <h1>Dispatch desk</h1>
            <p className="muted">Every delivery, from first assignment to final mile.</p>
          </div>
          <div className="head-actions">
            <button onClick={refresh}>Refresh</button>
            <button
              className="primary"
              onClick={() => {
                setForm(form === 'job' ? null : 'job');
                setSelection(null);
              }}
            >
              + New job
            </button>
          </div>
        </div>
        {dashboard.error && <ErrorBox error={dashboard.error} retry={dashboard.reload} />}
        <section aria-label="Workload overview" className="metrics">
          {[
            ['Received', data?.total],
            ['Awaiting assignment', data?.awaitingAssignment],
            ['Awaiting confirmation', data?.byStatus.AWAITING_CONFIRMATION],
            ['In progress', data?.inProgress],
            ['Manual queue', data?.byStatus.MANUAL_QUEUE],
            ['Delivered', data?.byStatus.DELIVERED],
            ['Cancelled', data?.byStatus.CANCELLED],
          ].map(([title, value]) => (
            <div
              className={`metric ${title === 'Manual queue' ? 'attention-metric' : ''}`}
              key={title}
            >
              <span>{title}</span>
              <strong>{value ?? '—'}</strong>
            </div>
          ))}
        </section>
        <div className="sync-note">
          {dashboard.loading
            ? 'Loading workload…'
            : data
              ? `Snapshot ${date(data.asOf)} · refreshes every 5 seconds · all times local`
              : 'Workload unavailable'}
        </div>
        {data && data.attentionTotal > 0 && (
          <section className="attention-strip" aria-label="Needs attention">
            <div>
              <strong>{data.attentionTotal} jobs need attention</strong>
              <p>
                Manual intervention, overdue deadlines or overdue confirmations. Due confirmations
                await worker processing.
              </p>
            </div>
            <div className="attention-links">
              {data.attention.slice(0, 5).map((j) => (
                <button key={j.id} onClick={() => openJob(j.id)}>
                  {j.orderReference}
                  <small>{label(j.attentionReason)}</small>
                </button>
              ))}
              {data.attentionTotal > 5 && (
                <span>{data.attentionTotal - 5} more · use filters below</span>
              )}
            </div>
          </section>
        )}
        <div className={`workspace ${selection || form ? 'with-detail' : ''}`}>
          <section className="panel queue" aria-label="Operational queues">
            <div className="section-head">
              <nav aria-label="Desk views">
                {(['jobs', 'manual', 'riders'] as const).map((value) => (
                  <button
                    key={value}
                    aria-pressed={tab === value}
                    className={tab === value ? 'active-tab' : ''}
                    onClick={() => switchTab(value)}
                  >
                    {value === 'manual' ? 'Manual queue' : label(value)}
                  </button>
                ))}
              </nav>
              {tab === 'riders' && (
                <button
                  onClick={() => {
                    setForm('rider');
                    setSelection(null);
                  }}
                >
                  + Add rider
                </button>
              )}
            </div>
            <div className="filters">
              <form onSubmit={submitSearch} key={tab}>
                <label className="sr-only" htmlFor="search">
                  {tab === 'riders' ? 'Rider code' : 'Order reference'}
                </label>
                <input
                  id="search"
                  name="search"
                  placeholder={tab === 'riders' ? 'Exact rider code' : 'Exact order reference'}
                  disabled={tab === 'manual'}
                />
                <button disabled={tab === 'manual'}>Search</button>
                <button
                  type="button"
                  onClick={() => {
                    setSearch('');
                    setPage(1);
                  }}
                >
                  Clear
                </button>
              </form>
              <label>
                Zone
                <select
                  value={zone}
                  onChange={(e) => {
                    setZone(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">All zones</option>
                  {zones.map((z) => (
                    <option key={z}>{z}</option>
                  ))}
                </select>
              </label>
              {tab === 'jobs' && (
                <label>
                  Status
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
                        {label(s)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {jobs.loading && (
              <p className="empty" role="status">
                Loading {tab}…
              </p>
            )}
            {jobs.error && <ErrorBox error={jobs.error} retry={jobs.reload} />}
            {jobs.data && (
              <>
                {jobs.data.data.length === 0 ? (
                  <p className="empty">
                    No {tab === 'manual' ? 'jobs in the manual queue' : tab} match this view.
                  </p>
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        {tab === 'riders' ? (
                          <tr>
                            <th>Rider</th>
                            <th>Coverage / current</th>
                            <th>Availability</th>
                            <th>Workload</th>
                          </tr>
                        ) : (
                          <tr>
                            <th>Order / route</th>
                            <th>Status</th>
                            <th>Load / priority</th>
                            <th>{tab === 'manual' ? 'Intervention' : 'Deadline'}</th>
                          </tr>
                        )}
                      </thead>
                      <tbody>
                        {jobs.data.data.map((row) => {
                          if ('code' in row)
                            return (
                              <tr key={row.id}>
                                <td>
                                  <button
                                    className="link-button"
                                    onClick={() => {
                                      setSelection({ kind: 'rider', id: row.id });
                                      setForm(null);
                                    }}
                                  >
                                    {row.name}
                                  </button>
                                  <small>{row.code}</small>
                                </td>
                                <td>
                                  {row.serviceZones.join(', ')}
                                  <small>Now {row.currentZone}</small>
                                </td>
                                <td>
                                  <Badge value={row.availability} />
                                </td>
                                <td>
                                  <strong>
                                    {row.availableUnits} / {row.capacityUnits} free units
                                  </strong>
                                  <small>
                                    {row.reservedUnits} reserved · {row.activeJobCount} active
                                  </small>
                                </td>
                              </tr>
                            );
                          return (
                            <tr key={row.id}>
                              <td>
                                <button className="link-button" onClick={() => openJob(row.id)}>
                                  {row.orderReference}
                                </button>
                                <small>
                                  {row.pickupZone} → {row.deliveryZone}
                                </small>
                              </td>
                              <td>
                                <Badge value={row.status} />
                                {row.assignedRiderId && (
                                  <small>
                                    {fleet.data?.data.find((r) => r.id === row.assignedRiderId)
                                      ?.code ?? row.assignedRiderId.slice(-6)}
                                  </small>
                                )}
                              </td>
                              <td>
                                {row.loadUnits} units<small>{label(row.priority)}</small>
                              </td>
                              <td>
                                {'manualAgeMs' in row ? (
                                  <>
                                    <strong>{label(row.manualReason ?? '')}</strong>
                                    <small>
                                      {row.manualAgeMs === null
                                        ? 'Entry history incomplete'
                                        : `${Math.floor(row.manualAgeMs / 60000)} min in manual queue`}
                                    </small>
                                    {row.latestAttempt && (
                                      <small>Last attempt: {label(row.latestAttempt.status)}</small>
                                    )}
                                    {row.latestAssignmentFailure && (
                                      <small className="failure">
                                        {row.latestAssignmentFailure.code}:{' '}
                                        {row.latestAssignmentFailure.reason} (
                                        {date(row.latestAssignmentFailure.occurredAt)})
                                      </small>
                                    )}
                                  </>
                                ) : (
                                  date(row.deadlineAt)
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <Pager pagination={jobs.data.pagination} change={setPage} />
              </>
            )}
          </section>
          {form === 'job' && (
            <JobForm
              open={openJob}
              done={() => {
                setForm(null);
                refresh();
              }}
            />
          )}
          {form === 'rider' && (
            <RiderForm
              done={() => {
                setForm(null);
                refresh();
              }}
            />
          )}
          {selection?.kind === 'job' && (
            <JobDetail
              key={selection.id}
              id={selection.id}
              revision={revision}
              changed={refresh}
              riders={fleet.data?.data ?? []}
              close={() => setSelection(null)}
            />
          )}
          {selection?.kind === 'rider' && (
            <RiderDetail
              key={selection.id}
              id={selection.id}
              revision={revision}
              changed={refresh}
              openJob={openJob}
              close={() => setSelection(null)}
            />
          )}
        </div>
        <footer>
          RELAY · Simulated zones and travel times · Capacity is reserved until rejection, expiry,
          cancellation or delivery.
        </footer>
      </main>
    </div>
  );
}
