import { Router } from 'express';
import { tenantOf } from '../../http/context.ts';
import { parseOr422, uuidOr404 } from '../../http/validation.ts';
import { bookingBody } from './booking.schemas.ts';
import { bookAppointment, getAppointment, type BookingDeps } from './booking.service.ts';

/**
 * Mounted under /appointments, behind requireTenantContext.
 * Booking outcomes: 201 granted, 409 slot already taken, 422 invalid request.
 */
export function createBookingRouter(deps: BookingDeps): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const body = parseOr422(bookingBody, req.body);
    res.status(201).json(await bookAppointment(deps, tenantOf(res), body));
  });

  router.get('/:appointmentId', async (req, res) => {
    const appointmentId = uuidOr404(req.params.appointmentId);
    res.json(await getAppointment(deps, tenantOf(res), appointmentId));
  });

  return router;
}
