import { Router } from 'express';
import { z } from 'zod';
import { serviceZoneSchema } from '../../http/contracts.js';
import type { DashboardService } from './service.js';
export const dashboardQuery = z.object({ zone: serviceZoneSchema.optional() }).strict();
export function createDashboardRouter(dashboard: DashboardService) {
  const router = Router();
  router.get('/', async (req, res) => {
    const input = dashboardQuery.parse(req.query);
    res.json(await dashboard.read(input.zone));
  });
  return router;
}
