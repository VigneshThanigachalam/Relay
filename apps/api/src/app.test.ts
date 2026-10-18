import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';

describe('HTTP foundation (no database)', () => {
  it('reports process liveness independently of database availability', async () => {
    const result = await request(createApp()).get('/health/live');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ data: { status: 'ok' } });
    expect(result.headers['x-powered-by']).toBeUndefined();
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('reports unavailable readiness instead of pretending a database is connected', async () => {
    const result = await request(createApp()).get('/health/ready');
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(result.body.requestId).toBe(result.headers['x-request-id']);
  });

  it('reports readiness from the injected connection probe', async () => {
    let ready = true;
    const app = createApp({ isReady: () => ready });
    expect((await request(app).get('/health/ready')).status).toBe(200);
    ready = false;
    expect((await request(app).get('/health/ready')).status).toBe(503);
  });

  it('does not register business routes without injected services', async () => {
    const result = await request(createApp()).get('/api/v1/jobs');
    expect(result.status).toBe(404);
    expect(result.body.error).toEqual({ code: 'ROUTE_NOT_FOUND', message: 'Route not found' });
  });

  it('returns 400 for malformed JSON', async () => {
    const result = await request(createApp())
      .post('/api/v1/jobs')
      .set('Content-Type', 'application/json')
      .send('{');
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('INVALID_JSON');
  });

  it('rejects oversized request bodies with 413', async () => {
    const result = await request(createApp())
      .post('/api/v1/jobs')
      .send({ value: 'a'.repeat(70 * 1024) });
    expect(result.status).toBe(413);
    expect(result.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('contains unexpected errors without exposing secrets', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const app = createApp({
        isReady: () => {
          throw new Error('mongodb://user:secret@internal');
        },
      });
      const result = await request(app).get('/health/ready');
      expect(result.status).toBe(500);
      expect(result.body.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(result.body)).not.toContain('secret');
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
    } finally {
      log.mockRestore();
    }
  });
});
