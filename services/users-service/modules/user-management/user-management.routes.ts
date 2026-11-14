import { Router, type Request } from 'express';
import { requirePermission, extractTenantContext } from '@medicitas/auth';
import { z } from 'zod';
import { UserManagementError } from './user-management.errors.ts';
import { changeClinicUser, createClinicUser, createFirstAdmin, type Management } from './user-management.service.ts';

export function userManagement(deps: Management, clinicsUrl: string | undefined) {
  const router = Router();
  const actor = (req: Request) => ({ctx:extractTenantContext(req)!,subject:req.user!.id});
  router.post('/',requirePermission('user:create'),async (req,res) => {
    try {
      res.status(201).json(await createClinicUser(deps,actor(req),req.body));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'activation_unconfirmed' && 'appUserId' in error) {
        res.location('/users/' + error.appUserId + '/role');
      }
      throw error;
    }
  });
  router.delete('/:id',requirePermission('user:deactivate'),async (req,res) => {
    await changeClinicUser(deps,actor(req),req.params.id,{deactivate:true});
    res.sendStatus(204);
  });
  router.put('/:id/role',requirePermission('user:assign-role'),async (req,res) => {
    await changeClinicUser(deps,actor(req),req.params.id,{roleBody:req.body});
    res.sendStatus(204);
  });
  router.post('/bootstrap/:id',requirePermission('clinic:create'),async (req,res) => {
    const caller = actor(req);
    if (caller.ctx.role !== 'platform_admin') throw new UserManagementError('forbidden');
    const id = z.uuid().safeParse(req.params.id);
    const body = z.strictObject({initialPassword:z.string().min(12).max(256)}).safeParse(req.body);
    if (!id.success || !body.success) throw new UserManagementError('invalid_request');
    const pending = z.object({clinicId:z.literal(id.data),appUserId:z.uuid(),username:z.string()});
    let registration;
    try {
      const response = await fetch(new URL('clinics/'+id.data+'/pending-admin',clinicsUrl?.replace(/\/?$/,'/')), {
        redirect:'error', signal:AbortSignal.timeout(5000),headers:{authorization:req.get('authorization')!}});
      if (response.status === 404) throw new UserManagementError('not_found');
      if (!response.ok) throw new Error();
      registration = pending.parse(await response.json());
    } catch (error) {
      if (error instanceof UserManagementError) throw error;
      throw new UserManagementError('bootstrap_unavailable');
    }
    res.status(201).json(await createFirstAdmin(deps,caller,registration,body.data.initialPassword));
  });
  return router;
}
