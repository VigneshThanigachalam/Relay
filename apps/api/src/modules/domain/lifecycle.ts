import type { AssignmentStatus, JobStatus } from './constants.js';

export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION';
  constructor(entity: string, status: string, action: string) {
    super(`Cannot ${action} ${entity} in ${status} state`);
    this.name = 'InvalidTransitionError';
  }
}

export type JobAction =
  | 'ready'
  | 'assign'
  | 'no_candidates'
  | 'accept'
  | 'reject'
  | 'expire'
  | 'pickup'
  | 'deliver'
  | 'cancel';
const jobTransitions: Record<JobStatus, Partial<Record<JobAction, JobStatus>>> = {
  NEW: { ready: 'READY_FOR_ASSIGNMENT', cancel: 'CANCELLED' },
  READY_FOR_ASSIGNMENT: {
    assign: 'AWAITING_CONFIRMATION',
    no_candidates: 'MANUAL_QUEUE',
    cancel: 'CANCELLED',
  },
  AWAITING_CONFIRMATION: {
    accept: 'ACCEPTED',
    reject: 'MANUAL_QUEUE',
    expire: 'MANUAL_QUEUE',
    cancel: 'CANCELLED',
  },
  ACCEPTED: { pickup: 'PICKED_UP', cancel: 'CANCELLED' },
  PICKED_UP: { deliver: 'DELIVERED' },
  MANUAL_QUEUE: { assign: 'AWAITING_CONFIRMATION', cancel: 'CANCELLED' },
  DELIVERED: {},
  CANCELLED: {},
};

export function transitionJob(status: JobStatus, action: JobAction): JobStatus {
  const next = jobTransitions[status][action];
  if (!next) throw new InvalidTransitionError('job', status, action);
  return next;
}

export type AssignmentAction = 'accept' | 'reject' | 'expire' | 'pickup' | 'deliver' | 'cancel';
const assignmentTransitions: Record<
  AssignmentStatus,
  Partial<Record<AssignmentAction, AssignmentStatus>>
> = {
  PENDING: { accept: 'ACCEPTED', reject: 'REJECTED', expire: 'EXPIRED', cancel: 'CANCELLED' },
  ACCEPTED: { pickup: 'PICKED_UP', cancel: 'CANCELLED' },
  PICKED_UP: { deliver: 'DELIVERED' },
  DELIVERED: {},
  REJECTED: {},
  EXPIRED: {},
  CANCELLED: {},
};

export function transitionAssignment(
  status: AssignmentStatus,
  action: AssignmentAction,
): AssignmentStatus {
  const next = assignmentTransitions[status][action];
  if (!next) throw new InvalidTransitionError('assignment', status, action);
  return next;
}

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

// Equality belongs to expiry. Services must capture a fresh decision time on each
// transaction retry and still guard the stored PENDING state; time alone is not a lock.
export function isAssignmentExpired(expiresAt: Date, decisionTime: Date): boolean {
  if (!Number.isFinite(expiresAt.getTime()) || !Number.isFinite(decisionTime.getTime())) {
    throw new Error('Assignment decision requires valid dates');
  }
  return expiresAt.getTime() <= decisionTime.getTime();
}
