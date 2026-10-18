import { Router } from 'express';
import { z } from 'zod';
import {
  actorSchema,
  createJobSchema,
  emptyBodySchema,
  idempotencyKeySchema,
  jobIdSchema,
  listJobsSchema,
  paginationSchema,
} from './contracts.js';
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
  router.get('/', async (req, res) => {
    res.json(await jobs.list(listJobsSchema.parse(req.query)));
  });
  router.get('/:jobId', async (req, res) => {
    emptyBodySchema.parse(req.query);
    res.json(await jobs.detail(jobIdSchema.parse(req.params.jobId)));
  });
  router.post('/:jobId/ready', async (req, res) => {
    const id = jobIdSchema.parse(req.params.jobId);
    const headers = z
      .object({ 'x-actor-id': actorSchema })
      .parse({ 'x-actor-id': req.get('X-Actor-Id') });
    emptyBodySchema.parse(req.body);
    res.json(await jobs.ready(id, headers['x-actor-id']));
  });
  router.get('/:jobId/history', async (req, res) => {
    const id = jobIdSchema.parse(req.params.jobId);
    res.json(await jobs.history(id, paginationSchema.parse(req.query)));
  });
  return router;
}
