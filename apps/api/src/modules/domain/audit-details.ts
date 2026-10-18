import { z } from 'zod';
import {
  JOB_STATUSES,
  MANUAL_REASONS,
  PRIORITIES,
  SERVICE_ZONES,
  type EventType,
} from './constants.js';

const objectId = z.string().regex(/^[a-f0-9]{24}$/i);
const units = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reason = z.string().trim().min(1).max(500);
const score = z.number().finite().nonnegative();

// Persist the numeric explanation used at assignment time. Recomputing history
// with today's rider workload would tell a different story from the original choice.
export const recommendationSnapshotSchema = z
  .object({
    scoringVersion: z.literal('v1'),
    generatedAt: z.iso.datetime(),
    eligible: z.array(
      z
        .object({
          riderId: objectId,
          rank: z.number().int().positive(),
          totalCost: score,
          estimatedMinutes: score,
          availableUnits: units,
          activeJobCount: units,
          breakdown: z
            .object({ travelCost: score, workloadCost: score, deadlineCost: score })
            .strict(),
          reasons: z.array(reason).min(1),
          estimatedByFallback: z.boolean(),
        })
        .strict(),
    ),
    excluded: z.array(z.object({ riderId: objectId, reasons: z.array(reason).min(1) }).strict()),
  })
  .strict();
export type RecommendationSnapshot = z.infer<typeof recommendationSnapshotSchema>;

// Schemas are selected by event type. Mixed BSON alone would permit arbitrary,
// unexplainable audit payloads despite having a valid event-name enum.
export const auditDetails: Record<EventType, z.ZodType> = {
  JOB_CREATED: z
    .object({
      orderReference: reason,
      pickupZone: z.enum(SERVICE_ZONES),
      deliveryZone: z.enum(SERVICE_ZONES),
      loadUnits: units.refine((n) => n > 0),
      priority: z.enum(PRIORITIES),
    })
    .strict(),
  JOB_READY: z.object({ from: z.literal('NEW'), to: z.literal('READY_FOR_ASSIGNMENT') }).strict(),
  RIDERS_RECOMMENDED: z.object({ snapshot: recommendationSnapshotSchema }).strict(),
  ASSIGNMENT_CREATED: z.object({ riderId: objectId, expiresAt: z.iso.datetime() }).strict(),
  ASSIGNMENT_ACCEPTED: z.object({ riderId: objectId }).strict(),
  ASSIGNMENT_REJECTED: z.object({ reason, releasedUnits: units }).strict(),
  ASSIGNMENT_EXPIRED: z
    .object({ reason: z.literal('RESPONSE_TIMEOUT'), releasedUnits: units })
    .strict(),
  MANUAL_QUEUE_ENTERED: z.object({ reason: z.enum(MANUAL_REASONS) }).strict(),
  REASSIGNED: z
    .object({ previousAssignmentId: objectId, newAssignmentId: objectId, riderId: objectId })
    .strict(),
  MANUAL_OVERRIDE: z
    .object({
      reason,
      recommendedRiderId: objectId,
      chosenRiderId: objectId,
      scoringVersion: z.literal('v1'),
    })
    .strict(),
  JOB_PICKED_UP: z.object({ from: z.literal('ACCEPTED'), to: z.literal('PICKED_UP') }).strict(),
  JOB_DELIVERED: z
    .object({ from: z.literal('PICKED_UP'), to: z.literal('DELIVERED'), releasedUnits: units })
    .strict(),
  JOB_CANCELLED: z.object({ from: z.enum(JOB_STATUSES), reason, releasedUnits: units }).strict(),
  ASSIGNMENT_FAILED: z.object({ code: reason, reason, riderId: objectId.optional() }).strict(),
};
