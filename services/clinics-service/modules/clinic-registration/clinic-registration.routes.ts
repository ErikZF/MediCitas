import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { extractTenantContext, requirePermission } from '@medicitas/auth';
import { withTenantTx, MEDICITAS_APP_ROLE, type Database, isUuid } from '@medicitas/db';
import { z } from 'zod';
import { clinic } from '../../db/schema.ts';
import { parseClinicRegistration } from './clinic-registration.schemas.ts';

export function clinicRegistration(db: Database, usersUrl: string | undefined) {
  const router = Router();
  router.use(requirePermission('clinic:create'));
  router.use((req,_res,next) => {
    if (extractTenantContext(req)?.role !== 'platform_admin') throw Object.assign(new Error(),{status:403});
    next();
  });
  const options = {dbRoles:MEDICITAS_APP_ROLE};
  router.get('/:id/pending-admin',async (req,res) => {
    if (!isUuid(req.params.id)) throw Object.assign(new Error(),{status:404});
    const [row] = await withTenantTx(db,extractTenantContext(req)!,tx => tx.select().from(clinic).where(eq(clinic.clinicId,req.params.id as string)),options);
    if (!row || row.isActive || !row.bootstrapAdminId) throw Object.assign(new Error(),{status:404});
    res.json({clinicId:row.clinicId,appUserId:row.bootstrapAdminId,username:row.bootstrapUsername});
  });
  router.post('/',async (req,res) => {
    const input = parseClinicRegistration(req.body);
    const ctx = extractTenantContext(req)!;
    const row = await withTenantTx(db,ctx,async tx => {
      const [existing] = await tx.select().from(clinic).where(eq(clinic.identifier,input.identifier)).for('update');
      if (existing) {
        if (existing.isActive || !existing.bootstrapAdminId || existing.bootstrapUsername !== input.administrator.username ||
          existing.name !== input.name || existing.timeZone !== input.timeZone) throw Object.assign(new Error(),{status:409,code:'clinic_exists'});
        return existing;
      }
      const [pending] = await tx.insert(clinic).values({clinicId:randomUUID(),name:input.name,identifier:input.identifier,timeZone:input.timeZone,
        isActive:false,bootstrapAdminId:randomUUID(),bootstrapUsername:input.administrator.username}).returning();
      return pending!;
    },options);
    const unavailable = () => Object.assign(new Error(),{status:503,code:'bootstrap_unavailable'});
    let response: Response;
    try {
      response = await fetch(new URL('users/bootstrap/'+row.clinicId,usersUrl?.replace(/\/?$/,'/')), {
        method:'POST',redirect:'error',headers:{authorization:req.get('authorization')!,'content-type':'application/json'},
        body:JSON.stringify({initialPassword:input.administrator.initialPassword}),signal:AbortSignal.timeout(45000)});
    } catch { throw unavailable(); }
    if (response.status === 409) throw Object.assign(new Error(),{status:409,code:'bootstrap_conflict'});
    if (!response.ok) throw unavailable();
    const result = z.object({appUserId:z.literal(row.bootstrapAdminId!),clinicId:z.literal(row.clinicId),role:z.literal('clinic_admin')});
    if (!result.safeParse(await response.json().catch(()=>null)).success) throw unavailable();
    await withTenantTx(db,ctx,tx=>tx.update(clinic).set({isActive:true,bootstrapAdminId:null,bootstrapUsername:null}).where(eq(clinic.clinicId,row.clinicId)),options);
    res.status(201).json({clinicId:row.clinicId,identifier:row.identifier,appUserId:row.bootstrapAdminId});
  });
  return router;
}
