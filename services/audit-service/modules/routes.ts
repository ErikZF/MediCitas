import { Router } from 'express';

// Append-only audit log for clinical notes and patient contact data (RF18, RF19).
// Only the health check exists for now; domain routes are added per Trello card.
const routes = Router();

routes.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'audit-service' });
});

export default routes;
