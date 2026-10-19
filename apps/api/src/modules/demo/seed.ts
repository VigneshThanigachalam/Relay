import type { Connection } from 'mongoose';
import { systemClock, type Clock } from '../domain/lifecycle.js';
import { createDeliveryService } from '../delivery/service.js';
import { createDispatchService } from '../dispatch/service.js';
import { createResolutionService } from '../dispatch/resolution.js';
import { createJobSchema } from '../jobs/contracts.js';
import { createJobsService } from '../jobs/service.js';
import type { PersistenceModels } from '../persistence/models.js';
import { createRecommendationsService } from '../recommendations/service.js';
import { createRiderSchema } from '../riders/contracts.js';
import { createRidersService } from '../riders/service.js';

// Fixture construction uses normal service transactions. It never writes rider
// counters directly, deletes records or resets work a reviewer has progressed.
export async function seedDemo({
  connection,
  models,
  clock = systemClock,
}: {
  connection: Connection;
  models: PersistenceModels;
  clock?: Clock;
}) {
  const actor = 'seed:demo';
  const now = clock.now();
  const riders = createRidersService({ connection, models, clock });
  const definitions = [
    {
      code: 'DEMO-MAYA',
      name: 'Maya Chen',
      serviceZones: ['CENTRAL', 'NORTH', 'SOUTH', 'EAST', 'WEST'],
      currentZone: 'CENTRAL',
      capacityUnits: 10,
    },
    {
      code: 'DEMO-ARUN',
      name: 'Arun Shah',
      serviceZones: ['CENTRAL', 'NORTH'],
      currentZone: 'NORTH',
      capacityUnits: 8,
    },
    {
      code: 'DEMO-LENA',
      name: 'Lena Ortiz',
      serviceZones: ['CENTRAL', 'EAST', 'WEST'],
      currentZone: 'EAST',
      capacityUnits: 6,
      availability: 'UNAVAILABLE',
    },
    {
      code: 'DEMO-NOAH',
      name: 'Noah Kim',
      serviceZones: ['NORTH'],
      currentZone: 'NORTH',
      capacityUnits: 4,
    },
    {
      code: 'DEMO-FULL',
      name: 'Isha Patel',
      serviceZones: ['CENTRAL', 'NORTH'],
      currentZone: 'CENTRAL',
      capacityUnits: 2,
    },
  ];
  const riderIds = new Map<string, string>();
  for (const definition of definitions) {
    const existing = await models.Rider.findOne({ code: definition.code }).maxTimeMS(5000).lean();
    const id =
      existing?._id.toHexString() ??
      (await riders.create(createRiderSchema.parse(definition), actor)).data.id;
    riderIds.set(definition.code, id);
  }
  const created: string[] = [],
    skipped: string[] = [];
  const specs = [
    ['DEMO-BUSY', 'accepted', 2, 'DEMO-FULL'],
    ['DEMO-NEW', 'new', 2],
    ['DEMO-READY', 'ready', 2],
    ['DEMO-OVERRIDE', 'ready', 2],
    ['DEMO-TIMEOUT', 'ready', 1],
    ['DEMO-REJECT', 'ready', 2],
    ['DEMO-NO-CANDIDATE', 'manual', 999],
    ['DEMO-REJECTED', 'rejected', 2],
    ['DEMO-DELIVERED', 'delivered', 2],
    ['DEMO-CANCELLED', 'cancelled', 1],
    ['DEMO-IN-FLIGHT', 'accepted', 2],
    ['DEMO-DEADLINE', 'deadline', 2],
    ['DEMO-OVERDUE', 'overdue', 1],
  ] as const;
  for (const [reference, target, load, code] of specs) {
    if (await models.Job.exists({ orderReference: reference }).maxTimeMS(5000)) {
      skipped.push(reference);
      continue;
    }
    const historical = target === 'overdue' || target === 'deadline';
    const fixtureClock = historical ? { now: () => new Date(now.getTime() - 3 * 3600000) } : clock;
    const deps = { connection, models, clock: fixtureClock };
    const jobs = createJobsService(deps);
    const job = (
      await jobs.create(
        createJobSchema.parse({
          orderReference: reference,
          pickupZone: 'CENTRAL',
          deliveryZone: 'NORTH',
          loadUnits: load,
          priority: target === 'deadline' ? 'URGENT' : 'NORMAL',
          ...(target === 'deadline'
            ? { deadlineAt: new Date(now.getTime() - 2 * 3600000).toISOString() }
            : {}),
        }),
        actor,
        `seed:${reference}`,
      )
    ).data;
    created.push(reference);
    if (target === 'new') continue;
    if (target === 'cancelled') {
      await createDeliveryService(deps).cancel(job.id, 'Demo customer cancellation', actor);
      continue;
    }
    await jobs.ready(job.id, actor);
    if (target === 'ready' || target === 'deadline') continue;
    if (target === 'manual') {
      await createRecommendationsService(deps).recommend(job.id, actor);
      continue;
    }
    const riderId = riderIds.get(code ?? 'DEMO-MAYA');
    if (!riderId) throw new Error('Demo rider missing');
    const assignment = (
      await createDispatchService({ ...deps, responseThresholdMs: 7200000 }).assign(
        job.id,
        { riderId, overrideReason: 'Seeded demonstration scenario' },
        actor,
        `seed:${reference}:assignment`,
      )
    ).data.assignment;
    if (target === 'overdue') continue; // Startup worker, not seed, owns expiry.
    const resolution = createResolutionService(deps);
    if (target === 'rejected') {
      await resolution.reject(assignment.id, 'Demo rider cannot reach pickup', `rider:${riderId}`);
      continue;
    }
    await resolution.accept(assignment.id, `rider:${riderId}`);
    if (target === 'delivered') {
      const delivery = createDeliveryService(deps);
      await delivery.pickup(job.id, assignment.id, actor);
      await delivery.deliver(job.id, assignment.id, actor);
    }
  }
  return { created, skipped, riders: riderIds.size };
}
