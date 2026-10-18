import request from 'supertest';
import mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { ApiError } from './api-error.js';
import { createJobSchema } from '../modules/jobs/contracts.js';
import { InvalidTransitionError } from '../modules/domain/lifecycle.js';

async function responseFor(error: unknown) {
  return request(
    createApp({
      isReady: () => {
        throw error;
      },
    }),
  ).get('/health/ready');
}
describe('public error mapping', () => {
  it('returns explicit domain conflict details and a matching request ID', async () => {
    const res = await responseFor(new ApiError(409, 'DUPLICATE_JOB', 'Order already exists'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_JOB');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });
  it('returns field-level Zod validation details', async () => {
    const parsed = createJobSchema.safeParse({});
    if (parsed.success) throw new Error('Expected invalid fixture');
    const res = await responseFor(parsed.error);
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'orderReference' })]),
    );
  });
  it('maps invalid lifecycle actions to a safe conflict', async () => {
    expect(
      (await responseFor(new InvalidTransitionError('job', 'DELIVERED', 'ready'))).status,
    ).toBe(409);
  });
  it.each([
    new mongoose.mongo.MongoNetworkError('mongodb://user:secret@internal'),
    new mongoose.mongo.MongoServerSelectionError('mongodb://user:secret@internal', {} as never),
    new mongoose.mongo.MongoOperationTimeoutError('database operation timed out'),
    new mongoose.mongo.MongoServerError({ message: 'query timed out', code: 50 }),
  ])('maps dependency failure to 503 without exposing internals', async (error) => {
    const res = await responseFor(error);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/secret|internal|stack/);
  });
  it('does not misclassify a programming error as an input or dependency error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await responseFor(new Error('private implementation bug'))).status).toBe(500);
    } finally {
      log.mockRestore();
    }
  });
});
