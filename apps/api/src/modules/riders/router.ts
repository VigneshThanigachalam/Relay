import { Router } from 'express';
import { z } from 'zod';
import { actorSchema, objectIdSchema, paginationSchema } from '../../http/contracts.js';
import { createRiderSchema, listRidersSchema, updateRiderSchema } from './contracts.js';
import type { RidersService } from './service.js';

const actorHeader = z.object({ 'x-actor-id': actorSchema });
export function createRidersRouter(riders: RidersService) {
  const router = Router();
  router.post('/', async (req, res) => {
    const headers = actorHeader.parse({ 'x-actor-id': req.get('X-Actor-Id') });
    res
      .status(201)
      .json(await riders.create(createRiderSchema.parse(req.body), headers['x-actor-id']));
  });
  router.get('/', async (req, res) => {
    res.json(await riders.list(listRidersSchema.parse(req.query)));
  });
  router.get('/:riderId', async (req, res) => {
    res.json(
      await riders.detail(
        objectIdSchema.parse(req.params.riderId),
        paginationSchema.parse(req.query),
      ),
    );
  });
  router.patch('/:riderId', async (req, res) => {
    const id = objectIdSchema.parse(req.params.riderId);
    const headers = actorHeader.parse({ 'x-actor-id': req.get('X-Actor-Id') });
    res.json(await riders.update(id, updateRiderSchema.parse(req.body), headers['x-actor-id']));
  });
  return router;
}
