import { Router } from 'express';
import { z } from 'zod';
import { actorSchema, createJobSchema, idempotencyKeySchema } from './contracts.js';
import type { JobsService } from './service.js';

const createHeaders = z.object({
  'x-actor-id': actorSchema,
  'idempotency-key': idempotencyKeySchema,
});
export function createJobsRouter(jobs: JobsService) {
  const router = Router();
  router.post('/', async (req, res) => {
    const headers = createHeaders.parse({
      'x-actor-id': req.get('X-Actor-Id'),
      'idempotency-key': req.get('Idempotency-Key'),
    });
    const input = createJobSchema.parse(req.body);
    const result = await jobs.create(input, headers['x-actor-id'], headers['idempotency-key']);
    res.status(result.replayed ? 200 : 201).json(result);
  });
  return router;
}
