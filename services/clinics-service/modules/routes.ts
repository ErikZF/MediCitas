import { Router } from 'express';

// Clinics, specialties and the service catalog (RF1, RF3).
// Only the health check exists for now; domain routes are added per Trello card.
const routes = Router();

routes.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'clinics-service' });
});

export default routes;
