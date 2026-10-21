import { useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { statuses, zones } from './types';
export type View = 'overview' | 'jobs' | 'manual' | 'riders';
export type DeskLocation = {
  view: View;
  zone: string;
  status: string;
  search: string;
  page: number;
};
export const viewPaths: Record<View, string> = {
  overview: '/overview',
  jobs: '/deliveries',
  manual: '/manual-queue',
  riders: '/riders',
};
export function readDeskLocation(view: View, searchParams: string): DeskLocation {
  const q = new URLSearchParams(searchParams);
  const zone = zones.find((z) => z === q.get('zone')) ?? '';
  const status = view === 'jobs' ? (statuses.find((s) => s === q.get('status')) ?? '') : '';
  const rawPage = q.get('page') ?? '1';
  const page = /^[1-9]\d*$/.test(rawPage) && Number(rawPage) <= 10000 ? Number(rawPage) : 1;
  const search =
    view === 'jobs' || view === 'riders'
      ? (q.get('search') ?? '').trim().slice(0, view === 'jobs' ? 80 : 100)
      : '';
  return { view, zone, status, search, page };
}
export function useDeskLocation(view: View) {
  const routerLocation = useLocation();
  const routerNavigate = useNavigate();
  const location = readDeskLocation(view, routerLocation.search);
  const current = useRef(location);
  current.current = location;
  const navigate = useCallback(
    (patch: Partial<DeskLocation>, replace = false) => {
      const next = { ...current.current, ...patch };
      if (JSON.stringify(next) === JSON.stringify(current.current)) return;
      const query = new URLSearchParams();
      if (next.zone) query.set('zone', next.zone);
      if (next.view === 'jobs' && next.status) query.set('status', next.status);
      if ((next.view === 'jobs' || next.view === 'riders') && next.search)
        query.set('search', next.search);
      if (next.page > 1) query.set('page', String(next.page));
      // Typing replaces the current entry; deliberate navigation/filter choices
      // push an entry so React Router restores state on Back/Forward.
      routerNavigate({ pathname: viewPaths[next.view], search: query.toString() }, { replace });
    },
    [routerNavigate],
  );
  return [location, navigate] as const;
}
