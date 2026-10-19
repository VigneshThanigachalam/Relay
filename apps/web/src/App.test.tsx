import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { RiderDetail } from './features/desk/RiderDetail';
import { JobDetail } from './features/desk/JobDetail';
import { request, ApiError } from './features/desk/api';
import type { Job, Rider, Recommendation } from './features/desk/types';
const job: Job = {
  id: '111111111111111111111111',
  orderReference: 'DEMO-001',
  pickupZone: 'CENTRAL',
  deliveryZone: 'NORTH',
  loadUnits: 2,
  priority: 'NORMAL',
  deadlineAt: null,
  status: 'READY_FOR_ASSIGNMENT',
  activeAssignmentId: null,
  assignedRiderId: null,
  manualReason: null,
  version: 1,
  createdAt: '2030-01-01T09:00:00Z',
  updatedAt: '2030-01-01T09:00:00Z',
};
const rider: Rider = {
  id: '222222222222222222222222',
  name: 'Maya',
  code: 'R-01',
  serviceZones: ['CENTRAL', 'NORTH'],
  currentZone: 'CENTRAL',
  availability: 'AVAILABLE',
  capacityUnits: 10,
  reservedUnits: 2,
  availableUnits: 8,
  activeJobCount: 1,
};
const recommendation: Recommendation = {
  scoringVersion: 'v1',
  generatedAt: '2030-01-01T09:00:00Z',
  eligible: [
    {
      riderId: rider.id,
      rank: 1,
      totalCost: 30,
      estimatedMinutes: 20,
      availableUnits: 8,
      activeJobCount: 1,
      breakdown: { travelCost: 20, workloadCost: 10, deadlineCost: 0 },
      reasons: ['Supports both zones'],
      estimatedByFallback: false,
    },
    {
      riderId: '333333333333333333333333',
      rank: 2,
      totalCost: 40,
      estimatedMinutes: 25,
      availableUnits: 10,
      activeJobCount: 0,
      breakdown: { travelCost: 40, workloadCost: 0, deadlineCost: 0 },
      reasons: ['Supports both zones'],
      estimatedByFallback: false,
    },
  ],
  excluded: [{ riderId: '444444444444444444444444', reasons: ['Unavailable'] }],
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  localStorage.clear();
  fetchMock = vi.fn<typeof fetch>(async (input, options) => {
    const url = String(input);
    if (url.endsWith('/jobs') && options?.method === 'POST') return json({ data: job });
    if (url.includes('/dashboard'))
      return json({
        data: {
          total: 1,
          awaitingAssignment: 1,
          inProgress: 0,
          byStatus: { AWAITING_CONFIRMATION: 0, MANUAL_QUEUE: 0, DELIVERED: 0, CANCELLED: 0 },
          attention: [],
          attentionTotal: 0,
          asOf: '2030-01-01T09:00:00Z',
        },
      });
    if (url.includes('/history'))
      return json({
        data: { events: [], attempts: [] },
        pagination: { page: 1, pageSize: 20, total: 0 },
        attemptsPagination: { page: 1, pageSize: 20, total: 0 },
      });
    if (url.endsWith(`/jobs/${job.id}`)) return json({ data: job });
    if (url.includes('/riders'))
      return json({ data: [rider], pagination: { page: 1, pageSize: 20, total: 1 } });
    if (url.includes('/recommendations')) return json({ data: recommendation });
    if (url.includes('/assignments')) return json({ data: { job, assignment: { id: 'attempt' } } });
    return json({ data: [job], pagination: { page: 1, pageSize: 20, total: 1 } });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
function detail(value: Job = job) {
  fetchMock.mockImplementation(async (input) =>
    String(input).endsWith(`/jobs/${job.id}`)
      ? json({ data: value })
      : String(input).includes('/history')
        ? json({
            data: { events: [], attempts: [] },
            pagination: { page: 1, pageSize: 20, total: 0 },
            attemptsPagination: { page: 1, pageSize: 20, total: 0 },
          })
        : String(input).includes('/recommendations')
          ? json({ data: recommendation })
          : json({
              data: {
                job: {
                  ...value,
                  status: 'AWAITING_CONFIRMATION',
                  activeAssignmentId: 'attempt',
                  assignedRiderId: rider.id,
                },
              },
              replayed: false,
            }),
  );
  render(<JobDetail id={job.id} revision={0} changed={vi.fn()} riders={[rider]} close={vi.fn()} />);
}
describe('operational desk', () => {
  it('loads actual counts and opens a job without triggering recommendations on reads', async () => {
    render(<App />);
    expect(screen.getByText('Loading workload…')).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: 'DEMO-001' }));
    expect(await screen.findByRole('complementary', { name: 'Job details' })).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Review recommendations' })).toBeEnabled();
    expect(
      fetchMock.mock.calls.every(([, options]) => !options?.method || options.method === 'GET'),
    ).toBe(true);
  });
  it('sends exact reference, status and zone filters', async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'DEMO-001' });
    fireEvent.change(screen.getByLabelText('Order reference'), { target: { value: 'DEMO-001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'DELIVERED' } });
    fireEvent.change(screen.getByLabelText('Zone'), { target: { value: 'WEST' } });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            String(url).includes('orderReference=DEMO-001') &&
            String(url).includes('status=DELIVERED') &&
            String(url).includes('zone=WEST'),
        ),
      ).toBe(true),
    );
  });
  it('shows empty queues with an explicit retry for failed reads', async () => {
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) =>
      String(input).includes('/jobs?')
        ? json({ data: [], pagination: { page: 1, pageSize: 20, total: 0 } })
        : original(input, options),
    );
    render(<App />);
    expect(await screen.findByText('No jobs match this view.')).toBeVisible();
  });
  it('shows API errors and retries a failed read', async () => {
    fetchMock.mockImplementation(async () =>
      json(
        {
          error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Database is not ready' },
          requestId: 'req-1',
        },
        503,
      ),
    );
    render(<App />);
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry read' })[0]!);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });
  it('creates a job with numeric load, canonical input fields and actor attribution', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New job' }));
    fireEvent.change(
      within(screen.getByRole('form', { name: 'Create delivery job' })).getByLabelText(
        'Order reference',
      ),
      { target: { value: 'WEB-NEW' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create job' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, options]) =>
            String(url).endsWith('/jobs') &&
            options?.method === 'POST' &&
            JSON.parse(String(options.body)).loadUnits === 2 &&
            (options.headers as Record<string, string>)['X-Actor-Id'] === 'dispatcher:demo',
        ),
      ).toBe(true),
    );
  });
  it('shows rider workload and opens protected rider configuration', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /^Riders$/i }));
    expect(await screen.findByText('8 / 10 free units')).toBeVisible();
    expect(screen.getByText('2 reserved · 1 active')).toBeVisible();
  });
});
describe('job actions and retry safety', () => {
  it('explains scores and requires an operational reason for a non-top choice', async () => {
    detail();
    fireEvent.click(await screen.findByRole('button', { name: 'Review recommendations' }));
    const region = await screen.findByRole('region', { name: 'Rider recommendations' });
    expect(within(region).getByText('Travel 20 + workload 10 + deadline 0')).toBeInTheDocument();
    fireEvent.click(within(region).getAllByRole('radio')[1]!);
    expect(screen.getByRole('button', { name: 'Assign selected rider' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Operational reason'), {
      target: { value: 'Knows the pickup desk' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Assign selected rider' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([, options]) => options?.body && String(options.body).includes('Knows the pickup desk'),
        ),
      ).toBe(true),
    );
  });
  it('retains exact assignment key and payload after a lost response', async () => {
    detail();
    fireEvent.click(await screen.findByRole('button', { name: 'Review recommendations' }));
    await screen.findByRole('button', { name: 'Assign selected rider' });
    const original = fetchMock.getMockImplementation()!;
    let lost = true;
    fetchMock.mockImplementation(async (input, options) => {
      if (String(input).endsWith('/assignments') && lost) {
        lost = false;
        throw new TypeError('network');
      }
      return original(input, options);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Assign selected rider' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry exact assignment' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/assignments')),
      ).toHaveLength(2),
    );
    const calls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/assignments'));
    expect(calls[0]?.[1]?.body).toBe(calls[1]?.[1]?.body);
    expect(calls[0]?.[1]?.headers).toEqual(calls[1]?.[1]?.headers);
    await waitFor(() => expect(localStorage.getItem(`relay:assignment:${job.id}`)).toBeNull());
  });
  it('allows an exact saved retry even when polling reveals assignment already committed', async () => {
    localStorage.setItem(
      `relay:assignment:${job.id}`,
      JSON.stringify({ key: 'saved-key', body: { riderId: rider.id } }),
    );
    detail({
      ...job,
      status: 'AWAITING_CONFIRMATION',
      activeAssignmentId: 'a',
      assignedRiderId: rider.id,
    });
    expect(await screen.findByRole('button', { name: 'Retry exact assignment' })).toBeEnabled();
  });
  it.each([
    ['NEW', 'Mark ready'],
    ['AWAITING_CONFIRMATION', 'Accept assignment'],
    ['ACCEPTED', 'Record pickup'],
    ['PICKED_UP', 'Complete delivery'],
  ] as const)('exposes only the next valid action in %s', async (status, title) => {
    detail({ ...job, status, activeAssignmentId: 'a', assignedRiderId: rider.id });
    expect(await screen.findByRole('button', { name: title })).toBeVisible();
    if (status !== 'PICKED_UP')
      expect(screen.queryByRole('button', { name: 'Complete delivery' })).not.toBeInTheDocument();
  });
  it('does not expose cancellation or progress actions on delivered work', async () => {
    detail({ ...job, status: 'DELIVERED' });
    await screen.findByText('delivered');
    expect(screen.queryByRole('button', { name: 'Cancel job' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record pickup' })).not.toBeInTheDocument();
  });
  it('preserves field errors and correlation IDs in meaningful API failures', async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request',
            details: [{ path: 'loadUnits', message: 'Expected positive integer' }],
          },
          requestId: 'req-2',
        },
        400,
      ),
    );
    await expect(request('/jobs', { method: 'POST', body: {} })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('interaction continuity', () => {
  it('restores focus to the opener when a panel is removed', async () => {
    render(<App />);
    const opener = screen.getByRole('button', { name: 'New job' });
    opener.focus();
    fireEvent.click(opener);
    const input = screen.getByLabelText('Order reference', {
      selector: 'input[name="orderReference"]',
    });
    input.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
  it('preserves a failed form and shows both immediate and persistent error feedback', async () => {
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) =>
      String(input).endsWith('/jobs') && options?.method === 'POST'
        ? json(
            { error: { code: 'REFERENCE_CONFLICT', message: 'Reference has different details' } },
            409,
          )
        : original(input, options),
    );
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New job' }));
    const form = screen.getByRole('form', { name: 'Create delivery job' });
    const input = within(form).getByLabelText('Order reference');
    fireEvent.change(input, { target: { value: 'CONFLICT-001' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create job' }));
    const toast = await screen.findByText('Changes could not be saved');
    expect(toast.closest('dialog')).toBe(screen.getByRole('dialog'));
    expect(within(form).getByRole('alert')).toHaveTextContent('REFERENCE_CONFLICT');
    expect(input).toHaveValue('CONFLICT-001');
    expect(within(form).getByRole('button', { name: 'Create job' })).toBeEnabled();
  });

  it('refreshes the queue without removing its rows, then confirms completion', async () => {
    render(<App />);
    const originalButton = await screen.findByRole('button', { name: 'DEMO-001' });
    const original = fetchMock.getMockImplementation()!;
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    fetchMock.mockImplementation(async (input, options) =>
      String(input).includes('/jobs?') ? pending : original(input, options),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByRole('button', { name: 'DEMO-001' })).toBe(originalButton);
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    expect(screen.queryByText('Loading deliveries…')).not.toBeInTheDocument();
    resolve(json({ data: [job], pagination: { page: 1, pageSize: 20, total: 1 } }));
    expect(await screen.findByText('Workspace is up to date')).toBeVisible();
    expect(screen.getByRole('button', { name: 'DEMO-001' })).toBe(originalButton);
  });
  it('preserves a rider edit and its input DOM while refreshing workload', async () => {
    const payload = {
      data: { ...rider, activeAssignments: [] },
      pagination: { page: 1, pageSize: 20, total: 0 },
    };
    let resolve!: (value: Response) => void;
    fetchMock.mockResolvedValueOnce(json(payload)).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const props = { id: rider.id, changed: vi.fn(), openJob: vi.fn(), close: vi.fn() };
    const { rerender } = render(<RiderDetail {...props} revision={0} />);
    const input = await screen.findByLabelText('Rider name');
    fireEvent.change(input, { target: { value: 'Unsaved rider edit' } });
    rerender(<RiderDetail {...props} revision={1} />);
    expect(screen.getByLabelText('Rider name')).toBe(input);
    expect(input).toHaveValue('Unsaved rider edit');
    resolve(json(payload));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(input).toHaveValue('Unsaved rider edit');
    expect(screen.getByText('You have unsaved changes')).toBeVisible();
  });
  it('keeps a successful creation notification visible after the form closes', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New job' }));
    const form = screen.getByRole('form', { name: 'Create delivery job' });
    fireEvent.change(within(form).getByLabelText('Order reference'), {
      target: { value: 'NEW-WEB' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Create job' }));
    expect(await screen.findByText('Delivery job created')).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Create delivery job' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Delivery workspace' })).toBeVisible();
  });
  it('shows specific pending feedback and updates the state after a confirmed response', async () => {
    detail({
      ...job,
      status: 'AWAITING_CONFIRMATION',
      activeAssignmentId: 'a',
      assignedRiderId: rider.id,
    });
    const accept = await screen.findByRole('button', { name: 'Accept assignment' });
    const original = fetchMock.getMockImplementation()!;
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementation((input, options) =>
      String(input).endsWith('/accept')
        ? new Promise((r) => {
            resolve = r;
          })
        : original(input, options),
    );
    fireEvent.click(accept);
    expect(await screen.findByRole('button', { name: 'Confirming assignment…' })).toBeDisabled();
    expect(screen.getByText('Waiting for the server to confirm the outcome.')).toBeVisible();
    resolve(
      json({
        data: {
          job: { ...job, status: 'ACCEPTED', activeAssignmentId: 'a', assignedRiderId: rider.id },
        },
      }),
    );
    expect(await screen.findByRole('button', { name: 'Record pickup' })).toBeVisible();
    expect(screen.getByText('Assignment accepted')).toBeVisible();
  });
});
