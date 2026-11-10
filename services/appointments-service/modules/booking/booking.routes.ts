import { Router } from 'express';
import { tenantOf } from '../../http/context.ts';
import { parseOr422, uuidOr404 } from '../../http/validation.ts';
import { bookingBody } from './booking.schemas.ts';
import { bookAppointment, getAppointment, type BookingDeps } from './booking.service.ts';
import { cancelBody, outcomeBody, rescheduleBody } from './lifecycle.schemas.ts';
import { cancelAppointment, recordOutcome, rescheduleAppointment } from './lifecycle.service.ts';

/**
 * Mounted under /appointments, behind requireTenantContext.
 * Booking outcomes: 201 granted, 409 slot already taken, 422 invalid request.
 * Life cycle (RF10-RF13): 409 invalid_transition when the status no longer allows it.
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

  router.post('/:appointmentId/reschedule', async (req, res) => {
    const appointmentId = uuidOr404(req.params.appointmentId);
    const body = parseOr422(rescheduleBody, req.body);
    res.status(201).json(await rescheduleAppointment(deps, tenantOf(res), appointmentId, body));
  });

  router.post('/:appointmentId/cancel', async (req, res) => {
    const appointmentId = uuidOr404(req.params.appointmentId);
    const body = parseOr422(cancelBody, req.body);
    res.json(await cancelAppointment(deps, tenantOf(res), appointmentId, body));
  });

  router.post('/:appointmentId/outcome', async (req, res) => {
    const appointmentId = uuidOr404(req.params.appointmentId);
    const body = parseOr422(outcomeBody, req.body);
    res.json(await recordOutcome(deps, tenantOf(res), appointmentId, body));
  });

  return router;
}
