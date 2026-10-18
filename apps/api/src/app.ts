import { randomUUID } from 'node:crypto';
import express from 'express';
import { errorHandler, sendError } from './http/errors.js';

type AppDependencies = { isReady?: () => boolean };

export function createApp({ isReady = () => false }: AppDependencies = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-Id', res.locals.requestId as string);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  app.get('/health/live', (_req, res) => {
    res.json({ data: { status: 'ok' } });
  });
  app.get('/health/ready', (req, res) => {
    if (!isReady()) {
      sendError(req, res, 503, 'DEPENDENCY_UNAVAILABLE', 'Database is not connected');
      return;
    }
    res.json({ data: { status: 'ready' } });
  });
  app.use((req, res) => {
    sendError(req, res, 404, 'ROUTE_NOT_FOUND', 'Route not found');
  });
  app.use(errorHandler);
  return app;
}
