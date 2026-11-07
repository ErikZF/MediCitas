import { Router } from 'express';

// Users, professionals and patients (RF2, RF4, RF14).
// Only the health check exists for now; domain routes are added per Trello card.
const routes = Router();

routes.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'users-service' });
});

export default routes;
