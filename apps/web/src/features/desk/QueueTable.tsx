import { Icon } from './Icon';
import { Badge, date, initials, titleCase } from './shared';
import type { Job, ManualJob, Rider } from './types';
export function QueueTable({
  items,
  view,
  selectedId,
  riders,
  openJob,
  openRider,
  stale,
  refreshing,
}: {
  items: (Job | ManualJob | Rider)[];
  view: 'overview' | 'jobs' | 'manual' | 'riders';
  selectedId: string | null;
  riders: Rider[];
  openJob: (id: string) => void;
  openRider: (id: string) => void;
  stale: boolean;
  refreshing: boolean;
}) {
  return (
    <div className={`table-scroll ${stale ? 'stale' : ''}`} aria-busy={refreshing}>
      <table>
        <thead>
          {view === 'riders' ? (
            <tr>
              <th>Rider</th>
              <th>Service zones</th>
              <th>Availability</th>
              <th>Capacity</th>
              <th>Workload</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          ) : view === 'manual' ? (
            <tr>
              <th>Order / route</th>
              <th>Intervention reason</th>
              <th>Last attempt</th>
              <th>Waiting</th>
              <th>Priority</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          ) : (
            <tr>
              <th>Order reference</th>
              <th>Route</th>
              <th>Status</th>
              <th>Rider</th>
              <th>Load</th>
              <th>Priority</th>
              <th>Deadline</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          )}
        </thead>
        <tbody>
          {items.map((row) => {
            if ('code' in row)
              return (
                <tr key={row.id} className={selectedId === row.id ? 'selected-row' : ''}>
                  <td>
                    <div className="rider-cell">
                      <span className="avatar">{initials(row.name)}</span>
                      <div>
                        <button className="link-button" onClick={() => openRider(row.id)}>
                          {row.name}
                        </button>
                        <small>{row.code}</small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="zone-tags">
                      {row.serviceZones.map((z) => (
                        <span key={z}>{titleCase(z)}</span>
                      ))}
                    </div>
                    <small className="current-zone">
                      <Icon name="pin" size={11} />
                      {titleCase(row.currentZone)} now
                    </small>
                  </td>
                  <td>
                    <Badge value={row.availability} />
                  </td>
                  <td>
                    <strong className="capacity-value">
                      {row.availableUnits} / {row.capacityUnits} free units
                    </strong>
                    <div className={`mini-track ${row.availableUnits === 0 ? 'full' : ''}`}>
                      <i
                        style={{
                          width: `${(row.reservedUnits / row.capacityUnits) * 100}%`,
                        }}
                      />
                    </div>
                  </td>
                  <td>
                    <span className="work-count">{row.activeJobCount}</span>
                    <small>
                      {row.reservedUnits} reserved · {row.activeJobCount} active
                    </small>
                  </td>
                  <td>
                    <button
                      className="row-open"
                      aria-label={`Open rider ${row.code}`}
                      onClick={() => openRider(row.id)}
                    >
                      <Icon name="chevron" size={16} />
                    </button>
                  </td>
                </tr>
              );
            const assigned = riders.find((r) => r.id === row.assignedRiderId);
            return (
              <tr key={row.id} className={selectedId === row.id ? 'selected-row' : ''}>
                <td>
                  <button className="link-button order-ref" onClick={() => openJob(row.id)}>
                    {row.orderReference}
                  </button>
                  <small>
                    {view === 'manual'
                      ? `${titleCase(row.pickupZone)} → ${titleCase(row.deliveryZone)}`
                      : `Received ${date(row.createdAt)}`}
                  </small>
                </td>
                {view === 'manual' && 'manualAgeMs' in row ? (
                  <>
                    <td className="intervention-cell">
                      <span className="reason-label">
                        <Icon name="alert" size={13} />
                        {titleCase(row.manualReason ?? 'Manual intervention')}
                      </span>
                      {row.latestAssignmentFailure && (
                        <small className="failure">
                          Last failure: {row.latestAssignmentFailure.code} ·{' '}
                          {row.latestAssignmentFailure.reason} ·{' '}
                          {date(row.latestAssignmentFailure.occurredAt)}
                        </small>
                      )}
                      {row.historyIncomplete && (
                        <small className="failure">Entry history incomplete</small>
                      )}
                    </td>
                    <td>
                      {row.latestAttempt ? (
                        <Badge value={row.latestAttempt.status} />
                      ) : (
                        <span className="muted">No prior attempt</span>
                      )}
                    </td>
                    <td>
                      {row.manualAgeMs === null
                        ? 'Unknown'
                        : `${Math.floor(row.manualAgeMs / 60000)} min`}
                      <small>In manual queue</small>
                    </td>
                    <td>
                      <span className={`priority ${row.priority.toLowerCase()}`}>
                        <i />
                        {titleCase(row.priority)}
                      </span>
                    </td>
                  </>
                ) : (
                  <>
                    <td>
                      <span className="table-route">
                        {titleCase(row.pickupZone)}
                        <Icon name="arrow" size={13} />
                        {titleCase(row.deliveryZone)}
                      </span>
                    </td>
                    <td>
                      <Badge value={row.status} />
                    </td>
                    <td>
                      {row.assignedRiderId ? (
                        <span className="assigned-name">
                          {assigned?.name ?? row.assignedRiderId.slice(-6)}
                        </span>
                      ) : (
                        <span className="unassigned">Unassigned</span>
                      )}
                    </td>
                    <td>
                      {row.loadUnits}
                      <small>units</small>
                    </td>
                    <td>
                      <span className={`priority ${row.priority.toLowerCase()}`}>
                        <i />
                        {titleCase(row.priority)}
                      </span>
                    </td>
                    <td
                      className={
                        row.deadlineAt &&
                        new Date(row.deadlineAt).getTime() < Date.now() &&
                        !['DELIVERED', 'CANCELLED'].includes(row.status)
                          ? 'overdue'
                          : ''
                      }
                    >
                      {date(row.deadlineAt)}
                    </td>
                  </>
                )}
                <td>
                  <button
                    className="row-open"
                    aria-label={`Open details for ${row.orderReference}`}
                    onClick={() => openJob(row.id)}
                  >
                    <Icon name="chevron" size={16} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
