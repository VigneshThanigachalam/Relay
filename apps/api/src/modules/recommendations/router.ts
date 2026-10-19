import { Router } from 'express';
import { z } from 'zod';
import { actorSchema, emptyObjectSchema, objectIdSchema } from '../../http/contracts.js';
import type { RecommendationsService } from './service.js';

export function createRecommendationsRouter(recommendations: RecommendationsService) {
  const router = Router();
  router.post('/:jobId/recommendations', async (req, res) => {
    const id = objectIdSchema.parse(req.params.jobId);
    const headers = z
      .object({ 'x-actor-id': actorSchema })
      .parse({ 'x-actor-id': req.get('X-Actor-Id') });
    emptyObjectSchema.parse(req.body);
    emptyObjectSchema.parse(req.query);
    res.json(await recommendations.recommend(id, headers['x-actor-id']));
  });
  return router;
}
