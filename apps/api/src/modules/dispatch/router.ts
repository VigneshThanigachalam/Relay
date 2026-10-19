import { Router } from 'express';
import { emptyObjectSchema, objectIdSchema } from '../../http/contracts.js';
import { assignmentHeadersSchema, assignJobSchema } from './contracts.js';
import type { DispatchService } from './service.js';

export function createDispatchRouter(dispatch: DispatchService) {
  const router = Router();
  router.post('/:jobId/assignments', async (req, res) => {
    const id = objectIdSchema.parse(req.params.jobId);
    const headers = assignmentHeadersSchema.parse({
      'x-actor-id': req.get('X-Actor-Id'),
      'idempotency-key': req.get('Idempotency-Key'),
    });
    emptyObjectSchema.parse(req.query);
    const input = assignJobSchema.parse(req.body);
    const result = await dispatch.assign(
      id,
      input,
      headers['x-actor-id'],
      headers['idempotency-key'],
    );
    res.status(result.replayed ? 200 : 201).json(result);
  });
  return router;
}
