import { createDashboardRouter } from './modules/dashboard/router.js';
import type { DashboardService } from './modules/dashboard/service.js';
import { randomUUID } from 'node:crypto';
import express, { type RequestHandler } from 'express';
import { errorHandler, sendError } from './http/errors.js';
import { createJobsRouter } from './modules/jobs/router.js';
import type { JobsService } from './modules/jobs/service.js';
import { createRidersRouter } from './modules/riders/router.js';
import type { RidersService } from './modules/riders/service.js';
import { createRecommendationsRouter } from './modules/recommendations/router.js';
import type { RecommendationsService } from './modules/recommendations/service.js';
import { createDispatchRouter } from './modules/dispatch/router.js';
import type { DispatchService } from './modules/dispatch/service.js';
import { createResolutionRouter } from './modules/dispatch/resolution-router.js';
import type { ResolutionService } from './modules/dispatch/resolution.js';
import { createManualQueueRouter } from './modules/manual-queue/router.js';
import type { ManualQueueService } from './modules/manual-queue/service.js';

import { createDeliveryRouter } from './modules/delivery/router.js';
import type { DeliveryService } from './modules/delivery/service.js';

type AppDependencies = {
  isReady?: () => boolean;
  jobs?: JobsService;
  riders?: RidersService;
  recommendations?: RecommendationsService;
  dispatch?: DispatchService;
  resolution?: ResolutionService;
  manualQueue?: ManualQueueService;
  delivery?: DeliveryService;
  dashboard?: DashboardService;
};

export function createApp({
  isReady = () => false,
  jobs,
  riders,
  recommendations,
  dispatch,
  resolution,
  manualQueue,
  delivery,
  dashboard,
}: AppDependencies = {}) {
  // Building the app must not open sockets or connect to MongoDB: Supertest can
  // exercise HTTP contracts while server.ts owns the real process lifecycle.
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
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
    // Liveness answers "is the process alive?"; readiness answers whether it
    // can safely serve work. Keeping them separate avoids false healthy states.
    if (!isReady()) {
      sendError(req, res, 503, 'DEPENDENCY_UNAVAILABLE', 'Database is not connected');
      return;
    }
    res.json({ data: { status: 'ready' } });
  });
  const requireReady: RequestHandler = (req, res, next) => {
    if (!isReady()) {
      sendError(req, res, 503, 'DEPENDENCY_UNAVAILABLE', 'Database is not ready');
      return;
    }
    next();
  };
  if (jobs) app.use('/api/v1/jobs', requireReady, createJobsRouter(jobs));
  if (riders) app.use('/api/v1/riders', requireReady, createRidersRouter(riders));
  if (recommendations)
    app.use('/api/v1/jobs', requireReady, createRecommendationsRouter(recommendations));
  if (dispatch) app.use('/api/v1/jobs', requireReady, createDispatchRouter(dispatch));
  if (resolution) app.use('/api/v1/assignments', requireReady, createResolutionRouter(resolution));
  if (manualQueue)
    app.use('/api/v1/manual-queue', requireReady, createManualQueueRouter(manualQueue));
  if (dashboard) app.use('/api/v1/dashboard', requireReady, createDashboardRouter(dashboard));
  if (delivery) app.use('/api/v1/jobs', requireReady, createDeliveryRouter(delivery));
  app.use((req, res) => {
    sendError(req, res, 404, 'ROUTE_NOT_FOUND', 'Route not found');
  });
  app.use(errorHandler);
  return app;
}
