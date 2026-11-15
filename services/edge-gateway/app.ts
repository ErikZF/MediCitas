import express, { type Express } from 'express';
import { errorHandler, notFoundHandler } from '@medicitas/http';
import { createProxy, type Upstreams } from './modules/proxy.ts';
import routes from './modules/routes.ts';

/**
 * The gateway's own routes (/ and /health) plus the proxy to the four services.
 * The proxy runs before any body parser: bodies are streamed to the service untouched.
 */
export function createGateway(upstreams: Upstreams = {}): Express {
  const app = express();
  app.use(routes);
  app.use(createProxy(upstreams));
  app.use(express.json());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export default createGateway();
