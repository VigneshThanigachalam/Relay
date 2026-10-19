import { Router } from 'express';
import { z } from 'zod';
import { actorSchema, emptyObjectSchema, objectIdSchema } from '../../http/contracts.js';
import type { DeliveryService } from './service.js';
export const progressSchema = z.object({ assignmentId: objectIdSchema }).strict();
export const cancelSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export function createDeliveryRouter(delivery: DeliveryService) {
  const router = Router();
  for (const action of ['pickup', 'deliver', 'cancel'] as const)
    router.post(`/:jobId/${action}`, async (req, res) => {
      const id = objectIdSchema.parse(req.params.jobId);
      const actor = actorSchema.parse(req.get('X-Actor-Id'));
      emptyObjectSchema.parse(req.query);
      if (action === 'cancel')
        res.json(await delivery.cancel(id, cancelSchema.parse(req.body).reason, actor));
      else res.json(await delivery[action](id, progressSchema.parse(req.body).assignmentId, actor));
    });
  return router;
}
