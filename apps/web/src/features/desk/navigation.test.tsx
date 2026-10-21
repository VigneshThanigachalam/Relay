import { act, renderHook } from '@testing-library/react';
import { BrowserRouter, useLocation } from 'react-router';
import { beforeEach, expect, it } from 'vitest';
import { readDeskLocation, useDeskLocation, viewPaths, type View } from './navigation';
beforeEach(() => window.history.replaceState(null, '', '/overview'));
function useRoutedDesk() {
  const { pathname } = useLocation();
  const view =
    (Object.keys(viewPaths) as View[]).find((v) => viewPaths[v] === pathname) ?? 'overview';
  return useDeskLocation(view);
}
const options = { wrapper: BrowserRouter };
it('validates URL inputs before they become API filters', () => {
  expect(readDeskLocation('overview', '?zone=FAKE&status=FAKE&page=-1')).toEqual({
    view: 'overview',
    zone: '',
    status: '',
    page: 1,
    search: '',
  });
});
it('preserves the route, filters and pagination in a reloadable URL', () => {
  const first = renderHook(useRoutedDesk, options);
  act(() =>
    first.result.current[1]({
      view: 'jobs',
      zone: 'NORTH',
      status: 'ACCEPTED',
      search: 'order-10',
      page: 2,
    }),
  );
  expect(window.location.pathname).toBe('/deliveries');
  first.unmount();
  const next = renderHook(useRoutedDesk, options);
  expect(next.result.current[0]).toEqual({
    view: 'jobs',
    zone: 'NORTH',
    status: 'ACCEPTED',
    search: 'order-10',
    page: 2,
  });
});
it('lets the router restore browser history and excludes delivery status from riders', () => {
  const { result } = renderHook(useRoutedDesk, options);
  act(() => result.current[1]({ view: 'riders', status: 'ACCEPTED' }));
  expect(result.current[0].status).toBe('');
  act(() => {
    window.history.replaceState(null, '', '/manual-queue?zone=WEST');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(result.current[0]).toMatchObject({ view: 'manual', zone: 'WEST', page: 1 });
});
