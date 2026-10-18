import { ACTIVE_ASSIGNMENT_STATUSES, type AssignmentStatus } from './constants.js';

export const normalizeReference = (value: string): string => value.trim().toUpperCase();
export const isNonNegativeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;
export const isPositiveInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

export function occupiesCapacity(status: AssignmentStatus): boolean {
  return (ACTIVE_ASSIGNMENT_STATUSES as readonly string[]).includes(status);
}

// Positive integer job loads imply at least one unit per active job. These are
// local counter checks; equality to the sum of attempts needs a transaction.
export function hasValidRiderCounters(capacity: number, reserved: number, active: number): boolean {
  return (
    isPositiveInteger(capacity) &&
    isNonNegativeInteger(reserved) &&
    isNonNegativeInteger(active) &&
    reserved <= capacity &&
    active <= reserved &&
    (reserved === 0) === (active === 0)
  );
}
