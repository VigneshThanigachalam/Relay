export const zones = ['CENTRAL', 'NORTH', 'SOUTH', 'EAST', 'WEST'] as const;
export const statuses = [
  'NEW',
  'READY_FOR_ASSIGNMENT',
  'AWAITING_CONFIRMATION',
  'ACCEPTED',
  'PICKED_UP',
  'DELIVERED',
  'MANUAL_QUEUE',
  'CANCELLED',
] as const;
export type JobStatus = (typeof statuses)[number];
export type Job = {
  id: string;
  orderReference: string;
  pickupZone: string;
  deliveryZone: string;
  loadUnits: number;
  priority: string;
  deadlineAt: string | null;
  status: JobStatus;
  activeAssignmentId: string | null;
  assignedRiderId: string | null;
  manualReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type Rider = {
  id: string;
  code: string;
  name: string;
  serviceZones: string[];
  currentZone: string;
  availability: string;
  capacityUnits: number;
  reservedUnits: number;
  availableUnits: number;
  activeJobCount: number;
};
export type Attempt = {
  id: string;
  jobId: string;
  riderId: string;
  status: string;
  active: boolean;
  loadUnits: number;
  assignedAt: string;
  expiresAt: string;
  respondedAt: string | null;
  endedAt: string | null;
  reservationReleasedAt: string | null;
  overrideReason: string | null;
  endReason: string | null;
  actor: string;
  recommendationSnapshot?: Recommendation;
};
export type Event = {
  id: string;
  sequence: number;
  type: string;
  occurredAt: string;
  actor: string;
  details: Record<string, unknown>;
};
export type Pagination = { page: number; pageSize: number; total: number };
export type Page<T> = { data: T[]; pagination: Pagination };
export type Recommendation = {
  generatedAt: string;
  scoringVersion: string;
  eligible: {
    riderId: string;
    rank: number;
    totalCost: number;
    estimatedMinutes: number;
    availableUnits: number;
    activeJobCount: number;
    breakdown: { travelCost: number; workloadCost: number; deadlineCost: number };
    reasons: string[];
    estimatedByFallback: boolean;
  }[];
  excluded: { riderId: string; reasons: string[] }[];
};
export type History = {
  data: { events: Event[]; attempts: Attempt[] };
  pagination: Pagination;
  attemptsPagination: Pagination;
};
export type ManualJob = Job & {
  manualEnteredAt: string | null;
  manualAgeMs: number | null;
  historyIncomplete: boolean;
  latestAttempt: Attempt | null;
  latestAssignmentFailure: { code: string; reason: string; occurredAt: string } | null;
};
export type Dashboard = {
  data: {
    total: number;
    awaitingAssignment: number;
    inProgress: number;
    byStatus: Record<JobStatus, number>;
    attention: (Job & { attentionReason: string })[];
    attentionTotal: number;
    asOf: string;
  };
};
