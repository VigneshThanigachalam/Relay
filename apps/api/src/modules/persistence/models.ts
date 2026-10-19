import { Schema, type Connection, type InferSchemaType } from 'mongoose';
import {
  ASSIGNMENT_STATUSES,
  AVAILABILITY_STATUSES,
  EVENT_TYPES,
  JOB_STATUSES,
  MANUAL_REASONS,
  PRIORITIES,
  SERVICE_ZONES,
  type EventType,
} from '../domain/constants.js';
import { auditDetails, recommendationSnapshotSchema } from '../domain/audit-details.js';
import {
  hasValidRiderCounters,
  isNonNegativeInteger,
  isPositiveInteger,
  normalizeReference,
  occupiesCapacity,
} from '../domain/invariants.js';

const options = {
  strict: 'throw',
  timestamps: true,
  versionKey: false,
  autoCreate: false,
  autoIndex: false,
} as const;
const positiveInteger = {
  type: Number,
  required: true,
  min: 1,
  max: Number.MAX_SAFE_INTEGER,
  validate: isPositiveInteger,
} as const;
const counter = {
  type: Number,
  required: true,
  default: 0,
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  validate: isNonNegativeInteger,
} as const;
const hash = { type: String, required: true, match: /^[a-f0-9]{64}$/ } as const;
const zone = { type: String, enum: SERVICE_ZONES, required: true } as const;

export const jobSchema = new Schema(
  {
    orderReference: {
      type: String,
      required: true,
      set: normalizeReference,
      maxlength: 80,
      immutable: true,
    },
    requestHash: { ...hash, immutable: true },
    // Missing keys must stay absent, not default to null: the unique index is partial.
    creationKey: { type: String, minlength: 1, maxlength: 128, immutable: true },
    pickupZone: zone,
    deliveryZone: zone,
    loadUnits: positiveInteger,
    priority: { type: String, enum: PRIORITIES, default: 'NORMAL', required: true },
    deadlineAt: Date,
    status: { type: String, enum: JOB_STATUSES, default: 'NEW', required: true },
    activeAssignmentId: { type: Schema.Types.ObjectId, ref: 'Assignment' },
    assignedRiderId: { type: Schema.Types.ObjectId, ref: 'Rider' },
    manualReason: { type: String, enum: MANUAL_REASONS },
    // Services own this CAS version. Mongoose's __v cannot guard query updates for us.
    version: counter,
    eventSequence: counter,
  },
  options,
);
jobSchema.pre('validate', function () {
  const assigned = ['AWAITING_CONFIRMATION', 'ACCEPTED', 'PICKED_UP'].includes(this.status);
  if (assigned !== Boolean(this.activeAssignmentId) || assigned !== Boolean(this.assignedRiderId)) {
    this.invalidate(
      'activeAssignmentId',
      'Active states require both assignment and rider pointers; other states must clear them',
    );
  }
  if ((this.status === 'MANUAL_QUEUE') !== Boolean(this.manualReason)) {
    this.invalidate('manualReason', 'Only manual-queue jobs must carry a manual reason');
  }
});
jobSchema.index({ orderReference: 1 }, { unique: true, name: 'job_reference_unique' });
jobSchema.index(
  { creationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { creationKey: { $type: 'string' } },
    name: 'job_creation_key_unique',
  },
);
jobSchema.index({ status: 1, createdAt: 1, _id: 1 }, { name: 'job_status_queue' });
jobSchema.index({ pickupZone: 1, status: 1, createdAt: 1 }, { name: 'job_pickup_queue' });
jobSchema.index({ deliveryZone: 1, status: 1, createdAt: 1 }, { name: 'job_delivery_queue' });

export const riderSchema = new Schema(
  {
    code: { type: String, required: true, set: normalizeReference, maxlength: 40, immutable: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    serviceZones: {
      type: [String],
      enum: SERVICE_ZONES,
      required: true,
      validate: {
        validator: (zones: string[]) => zones.length > 0 && new Set(zones).size === zones.length,
        message: 'Service zones must be nonempty and unique',
      },
    },
    currentZone: zone,
    availability: {
      type: String,
      enum: AVAILABILITY_STATUSES,
      default: 'AVAILABLE',
      required: true,
    },
    // Configuration provenance is not an append-only rider audit log. Job
    // lifecycle events remain in job_events; existing fixtures may lack these.
    createdBy: { type: String, trim: true, minlength: 1, maxlength: 80, immutable: true },
    updatedBy: { type: String, trim: true, minlength: 1, maxlength: 80 },
    capacityUnits: positiveInteger,
    reservedUnits: counter,
    activeJobCount: counter,
  },
  options,
);
riderSchema.pre('validate', function () {
  if (!hasValidRiderCounters(this.capacityUnits, this.reservedUnits, this.activeJobCount)) {
    this.invalidate('reservedUnits', 'Rider capacity and workload counters are inconsistent');
  }
});
riderSchema.index({ code: 1 }, { unique: true, name: 'rider_code_unique' });
riderSchema.index({ availability: 1, serviceZones: 1 }, { name: 'rider_zone_availability' });

export const assignmentSchema = new Schema(
  {
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true, immutable: true },
    riderId: { type: Schema.Types.ObjectId, ref: 'Rider', required: true, immutable: true },
    status: { type: String, enum: ASSIGNMENT_STATUSES, default: 'PENDING', required: true },
    active: { type: Boolean, required: true, default: true },
    loadUnits: { ...positiveInteger, immutable: true },
    assignedAt: { type: Date, required: true, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
    respondedAt: Date,
    endedAt: Date,
    reservationReleasedAt: Date,
    requestKey: { type: String, required: true, minlength: 1, maxlength: 128, immutable: true },
    requestHash: { ...hash, immutable: true },
    recommendationSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
      validate: {
        validator: (value: unknown) => recommendationSnapshotSchema.safeParse(value).success,
        message: 'Invalid recommendation snapshot',
      },
    },
    overrideReason: { type: String, trim: true, minlength: 1, maxlength: 500, immutable: true },
    actor: { type: String, required: true, trim: true, maxlength: 80, immutable: true },
    endReason: { type: String, trim: true, minlength: 1, maxlength: 500 },
  },
  options,
);
assignmentSchema.pre('validate', function () {
  const active = occupiesCapacity(this.status);
  if (this.active !== active) this.invalidate('active', 'Activity must match assignment status');
  if (active && (this.endedAt || this.reservationReleasedAt))
    this.invalidate('reservationReleasedAt', 'Active attempts cannot have released reservations');
  if (!active && (!this.endedAt || !this.reservationReleasedAt))
    this.invalidate(
      'reservationReleasedAt',
      'Terminal attempts require end and capacity-release timestamps',
    );
  if (this.assignedAt && this.expiresAt && this.expiresAt <= this.assignedAt)
    this.invalidate('expiresAt', 'Expiry must be after assignment');
  for (const field of ['respondedAt', 'endedAt', 'reservationReleasedAt'] as const) {
    const time = this[field];
    if (time && this.assignedAt && time < this.assignedAt)
      this.invalidate(field, 'Outcome cannot precede assignment');
  }
  if (
    this.status !== 'PENDING' &&
    this.status !== 'EXPIRED' &&
    this.status !== 'CANCELLED' &&
    !this.respondedAt
  )
    this.invalidate(
      'respondedAt',
      'Rider response timestamp is required after confirmation or rejection',
    );
  if (['REJECTED', 'EXPIRED', 'CANCELLED'].includes(this.status) && !this.endReason)
    this.invalidate('endReason', 'Failed or cancelled attempts require a reason');
});
// The partial index covers accepted and picked-up work too; pending-only uniqueness
// would accidentally permit a second assignment after the rider confirms.
assignmentSchema.index(
  { jobId: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: 'assignment_active_job_unique' },
);
assignmentSchema.index(
  { jobId: 1, requestKey: 1 },
  { unique: true, name: 'assignment_command_unique' },
);
assignmentSchema.index({ status: 1, expiresAt: 1, _id: 1 }, { name: 'assignment_due_queue' });
assignmentSchema.index({ jobId: 1, assignedAt: 1, _id: 1 }, { name: 'assignment_job_history' });

export const eventSchema = new Schema(
  {
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    sequence: positiveInteger,
    type: { type: String, enum: EVENT_TYPES, required: true },
    occurredAt: { type: Date, required: true },
    actor: { type: String, required: true, trim: true, maxlength: 80 },
    assignmentId: { type: Schema.Types.ObjectId, ref: 'Assignment' },
    details: {
      type: Schema.Types.Mixed,
      required: true,
      validate: {
        validator: function (this: { type: EventType }, value: unknown) {
          return auditDetails[this.type]?.safeParse(value).success ?? false;
        },
        message: 'Event details must match the event type',
      },
    },
  },
  { ...options, timestamps: false },
);
eventSchema.index({ jobId: 1, sequence: 1 }, { unique: true, name: 'event_job_sequence_unique' });

const appendOnlyError = () => new Error('Job history is append-only');
// Protect supported Mongoose mutation paths, including bulk/document operations.
// Raw collection access and privileged database users remain outside this boundary.
eventSchema.pre('save', function () {
  if (!this.isNew) throw appendOnlyError();
});
eventSchema.pre(
  [
    'updateOne',
    'updateMany',
    'replaceOne',
    'findOneAndUpdate',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  function () {
    throw appendOnlyError();
  },
);
eventSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw appendOnlyError();
});
eventSchema.pre('updateOne', { document: true, query: false }, function () {
  throw appendOnlyError();
});
eventSchema.pre('insertMany', function (next, _docs, options) {
  // lean insertMany skips Mongoose casting and validation, so it is not a safe
  // entry point for the audit schema's type-specific payload validation.
  if (options?.lean) return next(appendOnlyError());
  next();
});
eventSchema.pre('bulkWrite', function () {
  throw appendOnlyError();
});

export type JobRecord = InferSchemaType<typeof jobSchema>;
export type RiderRecord = InferSchemaType<typeof riderSchema>;
export type AssignmentRecord = InferSchemaType<typeof assignmentSchema>;
export type JobEventRecord = InferSchemaType<typeof eventSchema>;

// Explicit connection ownership makes isolated test databases possible and avoids
// domain code reaching for a hidden, process-global database connection.
export function createPersistenceModels(connection: Connection) {
  return {
    Job: connection.model<JobRecord>('Job', jobSchema, 'jobs'),
    Rider: connection.model<RiderRecord>('Rider', riderSchema, 'riders'),
    Assignment: connection.model<AssignmentRecord>('Assignment', assignmentSchema, 'assignments'),
    JobEvent: connection.model<JobEventRecord>('JobEvent', eventSchema, 'job_events'),
  };
}
export type PersistenceModels = ReturnType<typeof createPersistenceModels>;
