import { Router } from 'express';
import { extractTenantContext } from '@medicitas/auth';
import { CatalogError } from './service-catalog.errors.ts';
import { createService, deleteService, getService, listServices, updateService, type ServiceCatalogDeps } from './service-catalog.service.ts';

/** Mounted at /services after requiereToken and requiereTenantContext. */
export function createServiceCatalogRouter(deps: ServiceCatalogDeps): Router {
  const router = Router();

  router.use((req, _res, next) => {
    // No tenant selector, filters or pagination are part of the RF3 contract.
    if (Object.keys(req.query).length !== 0) throw new CatalogError(422);
    next();
  });

  router.post('/', async (req, res) => {
    const created = await createService(deps, extractTenantContext(req)!, req.body);
    res.status(201).location(`/services/${created.serviceId}`).json(created);
  });

  router.get('/', async (req, res) => {
    res.json(await listServices(deps, extractTenantContext(req)!));
  });

  router.get('/:serviceId', async (req, res) => {
    res.json(await getService(deps, extractTenantContext(req)!, req.params.serviceId));
  });

  router.put('/:serviceId', async (req, res) => {
    res.json(await updateService(deps, extractTenantContext(req)!, req.params.serviceId, req.body));
  });

  router.delete('/:serviceId', async (req, res) => {
    await deleteService(deps, extractTenantContext(req)!, req.params.serviceId);
    res.status(204).end();
  });

  return router;
}
