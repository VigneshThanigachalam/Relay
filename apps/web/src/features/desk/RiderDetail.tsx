import { useState } from 'react';
import { useResource } from './api';
import { RiderForm } from './forms';
import { Badge, ErrorBox, Pager } from './shared';
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
  }>(`/riders/${id}?page=${page}&pageSize=20`, revision);
  return (
    <aside className="panel detail" aria-label="Rider details">
      <div className="section-head">
        <h2>Rider details</h2>
        <button onClick={close}>Close</button>
      </div>
      {resource.loading && <p>Loading rider…</p>}
      {resource.error && <ErrorBox error={resource.error} retry={resource.reload} />}
      {resource.data && (
        <>
          <RiderForm rider={resource.data.data} done={changed} />
          <h3>Active workload</h3>
          <p>
            {resource.data.data.reservedUnits} of {resource.data.data.capacityUnits} units reserved
            · {resource.data.data.activeJobCount} active jobs
          </p>
          {resource.data.data.activeAssignments.length === 0 && (
            <p className="empty">No active assignments.</p>
          )}
          {resource.data.data.activeAssignments.map((a) => (
            <div className="work-row" key={a.id}>
              <button onClick={() => openJob(a.jobId)}>Open job {a.jobId.slice(-6)}</button>
              <Badge value={a.status} />
              <span>{a.loadUnits} units</span>
            </div>
          ))}
          <Pager pagination={resource.data.pagination} change={setPage} />
        </>
      )}
    </aside>
  );
}
