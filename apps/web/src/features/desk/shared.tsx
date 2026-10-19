import type { Pagination } from './types';
export const label = (value: string) => value.toLowerCase().replaceAll('_', ' ');
export const date = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');
export function Badge({ value }: { value: string }) {
  return <span className={`badge ${value.toLowerCase()}`}>{label(value)}</span>;
}
export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="error" role="alert">
      {error}
      {retry && <button onClick={retry}>Retry read</button>}
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
  return (
    <div className="pager">
      <span>
        {pagination.total} records · page {pagination.page} of {pages}
      </span>
      <button disabled={pagination.page <= 1} onClick={() => change(pagination.page - 1)}>
        Previous
      </button>
      <button disabled={pagination.page >= pages} onClick={() => change(pagination.page + 1)}>
        Next
      </button>
    </div>
  );
}
