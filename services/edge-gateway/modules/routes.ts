import { Router } from 'express';

const routes = Router();

routes.get('/', (_req, res) => {
  res.send('Hello World!');
});

routes.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

export default routes;
