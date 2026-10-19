import { useState } from 'react';
import { useResource } from './api';
import { RiderForm } from './forms';
import { Icon } from './Icon';
import { Badge, Empty, ErrorBox, initials, Pager, Skeleton } from './shared';
import type { Attempt, Pagination, Rider } from './types';
export function RiderDetail({
  id,
  revision,
  changed,
  openJob,
  close,
}: {
  id: string;
  revision: number;
  changed: () => void;
  openJob: (id: string) => void;
  close: () => void;
}) {
  const [page, setPage] = useState(1);
  const resource = useResource<{
    data: Rider & { activeAssignments: Attempt[] };
    pagination: Pagination;
  }>(`/riders/${id}?page=${page}&pageSize=20`, revision, `rider:${id}`);
  const rider = resource.data?.data;
  return (
    <aside className="detail" aria-label="Rider details">
      <div className="detail-toolbar">
        <span>
          <Icon name="riders" /> Rider profile
        </span>
        <button className="icon-button" aria-label="Close" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      {resource.loading && (
        <>
          <p role="status">Loading rider…</p>
          <Skeleton />
        </>
      )}
      {resource.error && <ErrorBox error={resource.error} retry={resource.reload} />}
      {rider && (
        <>
          <div className="rider-profile">
            <span className="avatar large">{initials(rider.name)}</span>
            <div>
              <h2>{rider.name}</h2>
              <p>
                {rider.code} · {rider.currentZone}
              </p>
            </div>
            <Badge value={rider.availability} />
          </div>
          <div className="capacity-card">
            <div>
              <span>Available capacity</span>
              <strong>
                {rider.availableUnits}
                <small>/ {rider.capacityUnits} units</small>
              </strong>
            </div>
            <div>
              <span>Active deliveries</span>
              <strong>{rider.activeJobCount}</strong>
            </div>
            <div className="capacity-track">
              <i style={{ width: `${(100 * rider.reservedUnits) / rider.capacityUnits}%` }} />
            </div>
            <p>{rider.reservedUnits} units reserved across pending and active deliveries</p>
          </div>
          <RiderForm rider={rider} done={changed} />
          <section className="workload-section">
            <h3>Active workload</h3>
            {rider.activeAssignments.length === 0 ? (
              <Empty
                title="No active assignments"
                description="This rider has no pending or in-progress deliveries."
              />
            ) : (
              rider.activeAssignments.map((a) => (
                <button className="work-row" key={a.id} onClick={() => openJob(a.jobId)}>
                  <span className="work-icon">
                    <Icon name="box" />
                  </span>
                  <span>
                    <strong>Delivery · {a.jobId.slice(-6)}</strong>
                    <small>{a.loadUnits} capacity units</small>
                  </span>
                  <Badge value={a.status} />
                  <Icon name="chevron" size={15} />
                </button>
              ))
            )}
            {resource.data && <Pager pagination={resource.data.pagination} change={setPage} />}
          </section>
        </>
      )}
    </aside>
  );
}
