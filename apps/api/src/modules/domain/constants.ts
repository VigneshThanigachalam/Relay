// A small fixed catalog makes simulated dispatch reproducible without a maps service.
export const SERVICE_ZONES = ['CENTRAL', 'NORTH', 'SOUTH', 'EAST', 'WEST'] as const;
export const JOB_STATUSES = [
  'NEW',
  'READY_FOR_ASSIGNMENT',
  'AWAITING_CONFIRMATION',
  'ACCEPTED',
  'PICKED_UP',
  'DELIVERED',
  'MANUAL_QUEUE',
  'CANCELLED',
] as const;
export const ASSIGNMENT_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'PICKED_UP',
  'DELIVERED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
] as const;
export const ACTIVE_ASSIGNMENT_STATUSES = ['PENDING', 'ACCEPTED', 'PICKED_UP'] as const;
export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export const AVAILABILITY_STATUSES = ['AVAILABLE', 'UNAVAILABLE'] as const;
export const MANUAL_REASONS = ['NO_ELIGIBLE_RIDER', 'RIDER_REJECTED', 'RESPONSE_TIMEOUT'] as const;
export const EVENT_TYPES = [
  'JOB_CREATED',
  'JOB_READY',
  'RIDERS_RECOMMENDED',
  'ASSIGNMENT_CREATED',
  'ASSIGNMENT_ACCEPTED',
  'ASSIGNMENT_REJECTED',
  'ASSIGNMENT_EXPIRED',
  'MANUAL_QUEUE_ENTERED',
  'REASSIGNED',
  'MANUAL_OVERRIDE',
  'JOB_PICKED_UP',
  'JOB_DELIVERED',
  'JOB_CANCELLED',
  'ASSIGNMENT_FAILED',
] as const;

export type ServiceZone = (typeof SERVICE_ZONES)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type ManualReason = (typeof MANUAL_REASONS)[number];
export type EventType = (typeof EVENT_TYPES)[number];
