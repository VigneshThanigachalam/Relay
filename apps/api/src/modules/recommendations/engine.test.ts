import { describe, expect, it } from 'vitest';
import { recommendationSnapshotSchema } from '../domain/audit-details.js';
import { SERVICE_ZONES } from '../domain/constants.js';
import {
  estimateLeg,
  rankRiders,
  TRAVEL_MINUTES,
  type RecommendationJob,
  type RecommendationRider,
} from './engine.js';

const now = new Date('2030-01-01T09:00:00Z');
const job: RecommendationJob = {
  pickupZone: 'CENTRAL',
  deliveryZone: 'NORTH',
  loadUnits: 2,
  priority: 'NORMAL',
};
const rider: RecommendationRider = {
  riderId: '507f191e810c19729de860ea',
  code: 'R-001',
  serviceZones: ['CENTRAL', 'NORTH'],
  currentZone: 'CENTRAL',
  availability: 'AVAILABLE',
  capacityUnits: 5,
  reservedUnits: 0,
  activeJobCount: 0,
};

describe('hard eligibility gates', () => {
  it.each([
    [{ availability: 'UNAVAILABLE' }, 'UNAVAILABLE'],
    [{ serviceZones: ['NORTH'] }, 'UNSUPPORTED_PICKUP_ZONE'],
    [{ serviceZones: ['CENTRAL'] }, 'UNSUPPORTED_DELIVERY_ZONE'],
    [{ reservedUnits: 4, activeJobCount: 1 }, 'INSUFFICIENT_CAPACITY'],
    [{ reservedUnits: 6, activeJobCount: 1 }, 'INVALID_WORKLOAD_COUNTERS'],
    [{ capacityUnits: 0 }, 'INVALID_WORKLOAD_COUNTERS'],
    [{ reservedUnits: 0, activeJobCount: 1 }, 'INVALID_WORKLOAD_COUNTERS'],
    [{ reservedUnits: 1, activeJobCount: 0 }, 'INVALID_WORKLOAD_COUNTERS'],
    [{ reservedUnits: -1 }, 'INVALID_WORKLOAD_COUNTERS'],
    [{ reservedUnits: 1.5, activeJobCount: 1 }, 'INVALID_WORKLOAD_COUNTERS'],
  ] as [Partial<RecommendationRider>, string][])('excludes %j with %s', (change, reason) => {
    const result = rankRiders(job, [{ ...rider, ...change }], now);
    expect(result.eligible).toEqual([]);
    expect(result.excluded).toEqual([{ riderId: rider.riderId, reasons: [reason] }]);
  });
  it('returns all applicable reasons, rather than only the first failed gate', () => {
    const result = rankRiders(
      job,
      [{ ...rider, availability: 'UNAVAILABLE', serviceZones: [], capacityUnits: 1 }],
      now,
    );
    expect(result.excluded[0]?.reasons).toEqual([
      'UNAVAILABLE',
      'UNSUPPORTED_PICKUP_ZONE',
      'UNSUPPORTED_DELIVERY_ZONE',
      'INSUFFICIENT_CAPACITY',
    ]);
  });
  it('allows exact remaining capacity and location outside coverage', () => {
    const result = rankRiders(
      job,
      [{ ...rider, currentZone: 'WEST', reservedUnits: 3, activeJobCount: 1 }],
      now,
    );
    expect(result.eligible[0]).toMatchObject({ availableUnits: 2, estimatedMinutes: 40 });
    expect(result.excluded).toEqual([]);
  });
  it('handles same-zone jobs and an empty fleet', () => {
    expect(
      rankRiders({ ...job, deliveryZone: 'CENTRAL' }, [rider], now).eligible[0]?.estimatedMinutes,
    ).toBe(0);
    expect(rankRiders(job, [], now)).toMatchObject({ eligible: [], excluded: [] });
  });
});

describe('explainable deterministic scoring', () => {
  it('records the formula components, remaining capacity, explanation and version', () => {
    const result = rankRiders(job, [{ ...rider, reservedUnits: 2, activeJobCount: 1 }], now);
    expect(result.eligible[0]).toMatchObject({
      rank: 1,
      estimatedMinutes: 25,
      availableUnits: 3,
      activeJobCount: 1,
      totalCost: 50.5,
      breakdown: { travelCost: 37.5, workloadCost: 13, deadlineCost: 0 },
      estimatedByFallback: false,
    });
    expect(result.eligible[0]?.reasons.join(' ')).toContain('NORMAL travel weight 1.5');
    expect(recommendationSnapshotSchema.parse(result)).toEqual(result);
  });
  it.each([
    ['LOW', 20],
    ['NORMAL', 30],
    ['HIGH', 40],
    ['URGENT', 60],
  ] as const)('weights %s travel cost as %s', (priority, travelCost) => {
    expect(rankRiders({ ...job, priority }, [rider], now).eligible[0]?.breakdown.travelCost).toBe(
      travelCost,
    );
  });
  it.each([
    [60, 0],
    [20, 0],
    [10, 40],
    [-5, 100],
  ])('prices a deadline %s minutes away at %s', (minutes, cost) => {
    const result = rankRiders(
      { ...job, deadlineAt: new Date(now.getTime() + minutes * 60_000) },
      [rider],
      now,
    );
    expect(result.eligible[0]?.breakdown.deadlineCost).toBe(cost);
    expect(result.eligible).toHaveLength(1);
  });
  it('lets urgency change travel versus workload preference', () => {
    const nearby = { ...rider, reservedUnits: 2, activeJobCount: 1 };
    const distant = {
      ...rider,
      riderId: '507f191e810c19729de860eb',
      code: 'R-002',
      currentZone: 'WEST' as const,
    };
    expect(
      rankRiders({ ...job, priority: 'LOW' }, [nearby, distant], now).eligible[0]?.riderId,
    ).toBe(distant.riderId);
    expect(
      rankRiders({ ...job, priority: 'URGENT' }, [nearby, distant], now).eligible[0]?.riderId,
    ).toBe(nearby.riderId);
  });
  it('uses binary code then ID ties, contiguous ranks and stable exclusion order', () => {
    const other = { ...rider, code: 'R-002', riderId: '507f191e810c19729de860eb' };
    const third = { ...rider, riderId: '507f191e810c19729de860ec' };
    const offline = {
      ...rider,
      riderId: '507f191e810c19729de860ed',
      availability: 'UNAVAILABLE' as const,
    };
    const fleet = [other, third, offline, rider];
    const result = rankRiders(job, fleet, now);
    expect(result).toEqual(rankRiders(job, [...fleet].reverse(), now));
    expect(result.eligible.map((r) => [r.riderId, r.rank])).toEqual([
      [rider.riderId, 1],
      [third.riderId, 2],
      [other.riderId, 3],
    ]);
    expect(fleet).toEqual([other, third, offline, rider]);
  });
  it('rounds components and total to six decimal places', () => {
    const result = rankRiders(
      job,
      [{ ...rider, capacityUnits: 3, reservedUnits: 1, activeJobCount: 1 }],
      now,
    );
    expect(result.eligible[0]).toMatchObject({
      totalCost: 49.166667,
      breakdown: { travelCost: 37.5, workloadCost: 11.666667, deadlineCost: 0 },
    });
  });
  it('returns finite valid snapshots for maximum supported counter values', () => {
    const result = rankRiders(
      { ...job, loadUnits: 1 },
      [
        {
          ...rider,
          capacityUnits: Number.MAX_SAFE_INTEGER,
          reservedUnits: Number.MAX_SAFE_INTEGER - 1,
          activeJobCount: Number.MAX_SAFE_INTEGER - 1,
        },
      ],
      now,
    );
    expect(recommendationSnapshotSchema.safeParse(result).success).toBe(true);
  });
  it('changes deadline cost as the explicit clock advances', () => {
    const timed = { ...job, deadlineAt: new Date(now.getTime() + 30 * 60_000) };
    expect(rankRiders(timed, [rider], now).eligible[0]?.breakdown.deadlineCost).toBe(0);
    expect(
      rankRiders(timed, [rider], new Date(now.getTime() + 20 * 60_000)).eligible[0]?.breakdown
        .deadlineCost,
    ).toBe(40);
  });
});

describe('simulated travel data', () => {
  it('covers all 25 zone pairs with symmetric nonnegative minutes and zero diagonals', () => {
    for (const from of SERVICE_ZONES)
      for (const to of SERVICE_ZONES) {
        expect(estimateLeg(from, to, TRAVEL_MINUTES)).toEqual({
          minutes: TRAVEL_MINUTES[from][to],
          fallback: false,
        });
        expect(TRAVEL_MINUTES[from][to]).toBe(TRAVEL_MINUTES[to][from]);
        expect(TRAVEL_MINUTES[from][to]).toBeGreaterThanOrEqual(0);
        if (from === to) expect(TRAVEL_MINUTES[from][to]).toBe(0);
      }
  });
  it.each([undefined, -1, NaN, Infinity])('uses 60 minutes for missing/invalid leg %s', (value) => {
    const matrix = value === undefined ? {} : { CENTRAL: { NORTH: value } };
    expect(estimateLeg('CENTRAL', 'NORTH', matrix)).toEqual({ minutes: 60, fallback: true });
  });
  it('flags a fallback per leg and includes it in both the score and explanation', () => {
    const result = rankRiders(job, [rider], now, {});
    expect(result.eligible[0]).toMatchObject({
      estimatedMinutes: 120,
      totalCost: 180,
      estimatedByFallback: true,
    });
    expect(result.eligible[0]?.reasons.join(' ')).toContain('60-minute fallback');
    const one = rankRiders(job, [rider], now, { CENTRAL: { CENTRAL: 0 } });
    expect(one.eligible[0]?.estimatedMinutes).toBe(60);
  });
});
