import { logger, startServer } from '@medicitas/http';
import { createGateway } from './app.ts';
import { readUpstreams } from './modules/proxy.ts';

// A service without its *_SERVICE_URL is not fatal: its routes answer 503 upstream_not_configured.
let upstreams;
try {
  upstreams = readUpstreams();
} catch {
  logger.error('Service URL configuration is invalid.');
  process.exitCode = 1;
}
if (upstreams !== undefined) startServer(createGateway(upstreams));
