import type { RecommendationSnapshot } from '../domain/audit-details.js';
import type { Priority, ServiceZone } from '../domain/constants.js';
import { hasValidRiderCounters } from '../domain/invariants.js';

export type RecommendationJob = {
  pickupZone: ServiceZone;
  deliveryZone: ServiceZone;
  loadUnits: number;
  priority: Priority;
  deadlineAt?: Date | null;
};
export type RecommendationRider = {
  riderId: string;
  code: string;
  serviceZones: readonly ServiceZone[];
  currentZone: ServiceZone;
  availability: 'AVAILABLE' | 'UNAVAILABLE';
  capacityUnits: number;
  reservedUnits: number;
  activeJobCount: number;
};
export type TravelMatrix = Readonly<
  Partial<Record<ServiceZone, Readonly<Partial<Record<ServiceZone, number>>>>>
>;

// Simulated minutes, not live traffic. Each missing/invalid leg costs 60 minutes
// rather than zero, so incomplete travel data never creates a misleading advantage.
export const TRAVEL_MINUTES = {
  CENTRAL: { CENTRAL: 0, NORTH: 20, SOUTH: 20, EAST: 15, WEST: 15 },
  NORTH: { CENTRAL: 20, NORTH: 0, SOUTH: 40, EAST: 30, WEST: 30 },
  SOUTH: { CENTRAL: 20, NORTH: 40, SOUTH: 0, EAST: 30, WEST: 30 },
  EAST: { CENTRAL: 15, NORTH: 30, SOUTH: 30, EAST: 0, WEST: 30 },
  WEST: { CENTRAL: 15, NORTH: 30, SOUTH: 30, EAST: 30, WEST: 0 },
} as const satisfies TravelMatrix;
const PRIORITY_WEIGHT: Record<Priority, number> = { LOW: 1, NORMAL: 1.5, HIGH: 2, URGENT: 3 };
const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function estimateLeg(from: ServiceZone, to: ServiceZone, matrix: TravelMatrix) {
  const value = matrix[from]?.[to];
  const valid = value !== undefined && Number.isFinite(value) && value >= 0;
  return { minutes: valid ? value : 60, fallback: !valid };
}

export function rankRiders(
  job: RecommendationJob,
  riders: readonly RecommendationRider[],
  now: Date,
  matrix: TravelMatrix = TRAVEL_MINUTES,
): RecommendationSnapshot {
  const snapshot: RecommendationSnapshot = {
    scoringVersion: 'v1',
    generatedAt: now.toISOString(),
    eligible: [],
    excluded: [],
  };
  // Sort a copy: deterministic ties and exclusion order must not depend on query
  // plans, insertion order or the host's locale. Keep caller-owned data untouched.
  const ordered = [...riders].sort(
    (a, b) => compareText(a.code, b.code) || compareText(a.riderId, b.riderId),
  );
  const codes = new Map(ordered.map((rider) => [rider.riderId, rider.code]));
  for (const rider of ordered) {
    const reasons: string[] = [];
    if (rider.availability !== 'AVAILABLE') reasons.push('UNAVAILABLE');
    if (!rider.serviceZones.includes(job.pickupZone)) reasons.push('UNSUPPORTED_PICKUP_ZONE');
    if (!rider.serviceZones.includes(job.deliveryZone)) reasons.push('UNSUPPORTED_DELIVERY_ZONE');
    const validCounters = hasValidRiderCounters(
      rider.capacityUnits,
      rider.reservedUnits,
      rider.activeJobCount,
    );
    if (!validCounters) reasons.push('INVALID_WORKLOAD_COUNTERS');
    const availableUnits = rider.capacityUnits - rider.reservedUnits;
    if (validCounters && availableUnits < job.loadUnits) reasons.push('INSUFFICIENT_CAPACITY');
    if (reasons.length) {
      snapshot.excluded.push({ riderId: rider.riderId, reasons });
      continue;
    }
    const toPickup = estimateLeg(rider.currentZone, job.pickupZone, matrix);
    const toDelivery = estimateLeg(job.pickupZone, job.deliveryZone, matrix);
    const estimatedMinutes = toPickup.minutes + toDelivery.minutes + 5 * rider.activeJobCount;
    const minutesUntilDeadline = job.deadlineAt
      ? (job.deadlineAt.getTime() - now.getTime()) / 60_000
      : null;
    const lateness =
      minutesUntilDeadline === null ? 0 : Math.max(0, estimatedMinutes - minutesUntilDeadline);
    // Round components before summing: the displayed breakdown explains the
    // stored total, and future history never recomputes using a changed workload.
    const breakdown = {
      travelCost: round(estimatedMinutes * PRIORITY_WEIGHT[job.priority]),
      workloadCost: round(
        20 * (rider.reservedUnits / rider.capacityUnits) + 5 * rider.activeJobCount,
      ),
      deadlineCost: round(4 * lateness),
    };
    snapshot.eligible.push({
      riderId: rider.riderId,
      rank: 1,
      totalCost: round(breakdown.travelCost + breakdown.workloadCost + breakdown.deadlineCost),
      estimatedMinutes,
      availableUnits,
      activeJobCount: rider.activeJobCount,
      breakdown,
      reasons: [
        'AVAILABLE; supports both zones',
        `${availableUnits} free units for ${job.loadUnits} required units`,
        `${estimatedMinutes} simulated minutes including ${5 * rider.activeJobCount} workload minutes`,
        `${job.priority} travel weight ${PRIORITY_WEIGHT[job.priority]}; ${rider.activeJobCount} active jobs`,
        minutesUntilDeadline === null
          ? 'No delivery deadline'
          : `${round(lateness)} estimated minutes late`,
        ...(toPickup.fallback || toDelivery.fallback
          ? ['60-minute fallback used for each missing travel leg']
          : []),
      ],
      estimatedByFallback: toPickup.fallback || toDelivery.fallback,
    });
  }
  snapshot.eligible.sort(
    (a, b) =>
      a.totalCost - b.totalCost ||
      compareText(codes.get(a.riderId)!, codes.get(b.riderId)!) ||
      compareText(a.riderId, b.riderId),
  );
  snapshot.eligible.forEach((candidate, index) => {
    candidate.rank = index + 1;
  });
  return snapshot;
}
