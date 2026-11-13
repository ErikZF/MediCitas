import { Router } from 'express';

// Clinics, specialties and the service catalog (RF1, RF3).
// Public health; the authenticated RF3 catalog is mounted by app.ts.
const routes = Router();

routes.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'clinics-service' });
});

export default routes;
