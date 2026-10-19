import type { Pagination } from './types';
import { Icon } from './Icon';
export const label = (value: string) => value.toLowerCase().replaceAll('_', ' ');
export const titleCase = (value: string) => label(value).replace(/\b\w/g, (c) => c.toUpperCase());
export const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'No deadline';
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
export function Badge({ value }: { value: string }) {
  return (
    <span className={`badge ${value.toLowerCase()}`}>
      <i />
      {label(value)}
    </span>
  );
}
export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="error" role="alert">
      <Icon name="alert" />
      <div>
        <strong>Something needs your attention</strong>
        <p>{error}</p>
        {retry && (
          <button onClick={retry}>
            Retry read <Icon name="refresh" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
export function Pager({
  pagination,
  change,
}: {
  pagination: Pagination;
  change: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(pagination.total / pagination.pageSize));
  const from = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.pageSize + 1;
  const to = Math.min(pagination.page * pagination.pageSize, pagination.total);
  return (
    <div className="pager">
      <span>
        Showing{' '}
        <b>
          {from}–{to}
        </b>{' '}
        of <b>{pagination.total}</b>
      </span>
      <div>
        <button
          aria-label="Previous page"
          disabled={pagination.page <= 1}
          onClick={() => change(pagination.page - 1)}
        >
          <Icon name="chevron" size={14} className="reverse" />
        </button>
        <span>
          Page {pagination.page} of {pages}
        </span>
        <button
          aria-label="Next page"
          disabled={pagination.page >= pages}
          onClick={() => change(pagination.page + 1)}
        >
          <Icon name="chevron" size={14} />
        </button>
      </div>
    </div>
  );
}
export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton-group" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}
export function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name="box" size={26} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
