import { Router } from 'express';
import { listManualQueueSchema } from './contracts.js';
import type { ManualQueueService } from './service.js';

export function createManualQueueRouter(queue: ManualQueueService) {
  const router = Router();
  router.get('/', async (req, res) => {
    res.json(await queue.list(listManualQueueSchema.parse(req.query)));
  });
  return router;
}
