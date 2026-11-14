import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, test, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenantTx, MEDICITAS_APP_ROLE } from '@medicitas/db';
import { createTestDatabase } from '../helpers/test-database.ts';
import { createClinicUser, createFirstAdmin, changeClinicUser, type Actor } from '../../modules/user-management/user-management.service.ts';
import { keycloakAdmin, type IdentityAdmin } from '../../adapters/keycloak-admin.ts';

const url = process.env.TEST_DATABASE_URL;
const clinicId = randomUUID();
const platform: Actor = {ctx:{clinicId:null,role:'platform_admin',userId:randomUUID()},subject:'platform-test'};
const admin: Actor = {ctx:{clinicId,role:'clinic_admin',userId:randomUUID()},subject:'admin-test'};
const input = { username:'j2-'+randomUUID(), role:'receptionist', initialPassword:randomUUID() };
describe.skipIf(!url)('J2 on disposable users_db',()=>{
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async()=>{
    database=await createTestDatabase(url!,'users');
    await database.pool.query(`insert into app_user(app_user_id,keycloak_sub,clinic_id,role_code)
      values ($1,$2,$3,'clinic_admin'),($4,$5,NULL,'platform_admin')`,[admin.ctx.userId,admin.subject,clinicId,platform.ctx.userId,platform.subject]);
  });
  afterAll(async()=>{await database?.drop();});

  test('cross-clinic writes and a platform RF2 actor are refused before identity changes',async()=>{
    const identity = keycloakAdmin({});
    const ctx = {...admin.ctx,clinicId:randomUUID()};
    await assert.rejects(changeClinicUser({...database,identity},{...admin,ctx},admin.ctx.userId,{deactivate:true}),{status:401});
    await assert.rejects(changeClinicUser({...database,identity},admin,platform.ctx.userId,{deactivate:true}),{status:404});
    await assert.rejects(createClinicUser({...database,identity},platform,input),{status:403});
  });

  test('failed role assignment rolls back SQL and removes the disabled account',async()=>{
    const sub = randomUUID();
    const identity: IdentityAdmin = {create:vi.fn(async()=>sub), assign:vi.fn(async()=>{throw new Error('assignment failed')}), enabled:vi.fn(),logout:vi.fn(),remove:vi.fn()};
    await assert.rejects(createClinicUser({...database,identity},admin,input),/assignment failed/);
    assert.equal(vi.mocked(identity.remove).mock.calls[0]?.[0],sub);
    assert.equal(vi.mocked(identity.enabled).mock.calls.length,0);
    assert.equal((await database.pool.query('select 1 from app_user where keycloak_sub=$1',[sub])).rowCount,0);
  });

  test.skipIf(process.env.J2_TEMP_REALM !== '1')('real Keycloak 26.7 and PostgreSQL provision, replace role, logout and deactivate',async()=>{
    const identity = keycloakAdmin();
    const deps = {...database,identity};
    const registered = await createClinicUser(deps,admin,input);
    const read = async()=> (await database.pool.query('select * from app_user where app_user_id=$1',[registered.appUserId])).rows[0];
    const row = await read();
    const first = {clinicId:randomUUID(),appUserId:randomUUID(),username:'first-'+randomUUID()};
    try {
      assert.equal(row.clinic_id,clinicId);
      await changeClinicUser(deps,admin,registered.appUserId,{roleBody:{role:'clinic_admin'}});
      assert.equal((await read()).role_code,'clinic_admin');
      await changeClinicUser(deps,admin,registered.appUserId,{deactivate:true});
      assert.equal((await read()).is_active,false);
      await createFirstAdmin(deps,platform,first,input.initialPassword);
      const [saved] = (await database.pool.query('select * from app_user where app_user_id=$1',[first.appUserId])).rows;
      assert.equal(saved.role_code,'clinic_admin');
      assert.equal(saved.is_first_admin,true);
      await identity.remove(saved.keycloak_sub);
      await assert.rejects(withTenantTx(database.db,platform.ctx,tx=>tx.execute(sql`insert into app_user (clinic_id,keycloak_sub,role_code,is_first_admin)
        values (${clinicId},${randomUUID()},'clinic_admin',true)`),{dbRoles:MEDICITAS_APP_ROLE}),{status:403});
    } finally {await identity.remove(row.keycloak_sub);}
  },60000);
});
