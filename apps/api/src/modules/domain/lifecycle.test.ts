import { describe, expect, it } from 'vitest';
import { ASSIGNMENT_STATUSES, JOB_STATUSES } from './constants.js';
import { hasValidRiderCounters, normalizeReference, occupiesCapacity } from './invariants.js';
import {
  InvalidTransitionError,
  isAssignmentExpired,
  transitionAssignment,
  transitionJob,
  type AssignmentAction,
  type JobAction,
} from './lifecycle.js';

describe('job lifecycle policy', () => {
  it('supports the complete confirmed delivery path without skipping NEW', () => {
    let job = transitionJob('NEW', 'ready');
    job = transitionJob(job, 'assign');
    job = transitionJob(job, 'accept');
    job = transitionJob(job, 'pickup');
    expect(transitionJob(job, 'deliver')).toBe('DELIVERED');
  });
  it.each(['reject', 'expire'] as const)('allows another dispatch after %s', (action) => {
    const manual = transitionJob('AWAITING_CONFIRMATION', action);
    expect(manual).toBe('MANUAL_QUEUE');
    expect(transitionJob(manual, 'assign')).toBe('AWAITING_CONFIRMATION');
  });
  it('keeps no-candidate work available in the manual queue', () => {
    expect(transitionJob('READY_FOR_ASSIGNMENT', 'no_candidates')).toBe('MANUAL_QUEUE');
  });
  it.each([
    'NEW',
    'READY_FOR_ASSIGNMENT',
    'MANUAL_QUEUE',
    'AWAITING_CONFIRMATION',
    'ACCEPTED',
  ] as const)('allows cancellation from %s before pickup', (status) => {
    expect(transitionJob(status, 'cancel')).toBe('CANCELLED');
  });
  it.each([
    ['NEW', 'assign'],
    ['NEW', 'deliver'],
    ['READY_FOR_ASSIGNMENT', 'accept'],
    ['AWAITING_CONFIRMATION', 'pickup'],
    ['AWAITING_CONFIRMATION', 'assign'],
    ['ACCEPTED', 'deliver'],
    ['PICKED_UP', 'cancel'],
    ['MANUAL_QUEUE', 'accept'],
  ] as const)('rejects invalid %s → %s actions', (status, action) => {
    expect(() => transitionJob(status, action)).toThrow(InvalidTransitionError);
  });
  it.each(['DELIVERED', 'CANCELLED'] as const)('makes %s terminal for every command', (status) => {
    const actions: JobAction[] = [
      'ready',
      'assign',
      'no_candidates',
      'accept',
      'reject',
      'expire',
      'pickup',
      'deliver',
      'cancel',
    ];
    for (const action of actions)
      expect(() => transitionJob(status, action)).toThrow(InvalidTransitionError);
  });
  it('retains all eight assignment-required job states', () =>
    expect(JOB_STATUSES).toHaveLength(8));
});

describe('attempt lifecycle and expiry policy', () => {
  it('keeps an accepted attempt active through pickup, then terminalizes delivery', () => {
    let status = transitionAssignment('PENDING', 'accept');
    expect(occupiesCapacity(status)).toBe(true);
    status = transitionAssignment(status, 'pickup');
    expect(occupiesCapacity(status)).toBe(true);
    expect(occupiesCapacity(transitionAssignment(status, 'deliver'))).toBe(false);
  });
  it.each(['reject', 'expire', 'cancel'] as const)(
    '%s terminalizes a pending attempt',
    (action) => {
      expect(occupiesCapacity(transitionAssignment('PENDING', action))).toBe(false);
    },
  );
  it('does not let the timeout worker expire confirmed work', () => {
    expect(() => transitionAssignment('ACCEPTED', 'expire')).toThrow(InvalidTransitionError);
    expect(() => transitionAssignment('PICKED_UP', 'expire')).toThrow(InvalidTransitionError);
  });
  it.each(['DELIVERED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const)(
    'prevents resurrection of %s',
    (status) => {
      const actions: AssignmentAction[] = [
        'accept',
        'reject',
        'expire',
        'pickup',
        'deliver',
        'cancel',
      ];
      for (const action of actions)
        expect(() => transitionAssignment(status, action)).toThrow(InvalidTransitionError);
    },
  );
  it('assigns the exact expiry instant to timeout, not acceptance', () => {
    const deadline = new Date('2030-01-01T10:00:00Z');
    expect(isAssignmentExpired(deadline, new Date(deadline.getTime() - 1))).toBe(false);
    expect(isAssignmentExpired(deadline, deadline)).toBe(true);
    expect(isAssignmentExpired(deadline, new Date(deadline.getTime() + 1))).toBe(true);
  });
  it('rejects invalid time values instead of treating them as unexpired', () => {
    expect(() => isAssignmentExpired(new Date('invalid'), new Date())).toThrow('valid dates');
  });
  it('occupies capacity for precisely the three active statuses', () => {
    expect(ASSIGNMENT_STATUSES.filter(occupiesCapacity)).toEqual([
      'PENDING',
      'ACCEPTED',
      'PICKED_UP',
    ]);
  });
});

describe('local data invariants', () => {
  it('normalizes human resubmissions before uniqueness checks', () =>
    expect(normalizeReference('  relay-42 ')).toBe('RELAY-42'));
  it.each([
    [5, 0, 0],
    [5, 2, 1],
    [5, 5, 3],
  ])('accepts consistent counter snapshot %j', (capacity, reserved, active) => {
    expect(hasValidRiderCounters(capacity, reserved, active)).toBe(true);
  });
  it.each([
    [5, 6, 1],
    [5, -1, 1],
    [5, 1, 2],
    [5, 2, 0],
    [5, 0, 1],
    [5, 1.5, 1],
    [0, 0, 0],
    [Number.MAX_SAFE_INTEGER + 1, 0, 0],
  ])('rejects inconsistent counters %j', (capacity, reserved, active) => {
    expect(hasValidRiderCounters(capacity, reserved, active)).toBe(false);
  });
});
