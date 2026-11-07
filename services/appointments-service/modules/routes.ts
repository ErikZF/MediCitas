import { Router } from 'express';

// Schedules, availability, appointments and clinical notes (RF5-RF13, RF15, RF16, RF20, RF21).
// Only the health check exists for now; domain routes are added per Trello card.
const routes = Router();

routes.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'appointments-service' });
});

export default routes;
