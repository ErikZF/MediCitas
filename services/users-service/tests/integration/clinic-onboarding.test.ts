import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { keycloakAdmin } from '../../adapters/keycloak-admin.ts';
import { createTestDatabase } from '../helpers/test-database.ts';
import { createApp } from '../../app.ts';

// Opt in only against the disposable j2 realm imported for integration tests.
test.skipIf(!process.env.TEST_DATABASE_URL || process.env.J2_TEMP_REALM !== '1')('HTTP RF1 and RF2 with real realm tokens and both databases', async()=>{
  const base = new URL(process.env.KEYCLOAK_INTERNAL_URL!);
  assert.equal(base.hostname,'127.0.0.1');
  assert.equal(process.env.REALM_NAME,'j2');
  const tokenUrl = new URL('/realms/j2/protocol/openid-connect/token',base);
  const identity = keycloakAdmin();
  const platformId = randomUUID(), username = 'platform-'+randomUUID(), password = randomUUID();
  const users = await createTestDatabase(process.env.TEST_DATABASE_URL!,'users');
  const servers:Server[] = [];
  const subjects:string[] = [];
  let clinics: typeof users | undefined;
  async function token(fields:Record<string,string>) {
    const r=await fetch(tokenUrl,{method:'POST',body:new URLSearchParams(fields)});
    assert.equal(r.status,200);
    return (await r.json()).access_token as string;
  }
  const serviceToken = await token({grant_type:'client_credentials',client_id:'medicitas-user-admin',client_secret:process.env.KEYCLOAK_USER_ADMIN_SECRET!});
  async function admin(path:string,method:string,status:number,body?:unknown) {
    const r=await fetch(new URL('/admin/realms/j2'+path,base),{method,headers:{authorization:'Bearer '+serviceToken,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(r.status,status);
    return r;
  }
  const signin=(name:string,pw:string)=>token({grant_type:'password',client_id:'j2-tests',username:name,password:pw});
  const post=(url:string,bearer:string,body:unknown)=>fetch(url,{method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},body:JSON.stringify(body)});
  async function listen() {
    const server=createServer();
    servers.push(server);
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const addr=server.address(); assert.ok(addr && typeof addr !== 'string');
    return {server,url:'http://127.0.0.1:'+addr.port};
  }
  try {
    clinics=await createTestDatabase(process.env.TEST_DATABASE_URL!,'clinics');
    const seed=await admin('/users','POST',201,{username,enabled:true,attributes:{app_user_id:[platformId],role:['platform_admin']},credentials:[{type:'password',value:password,temporary:false}]});
    const subject=seed.headers.get('location')!.split('/').pop()!;
    subjects.push(subject);
    const rolePath='/users/'+subject+'/role-mappings/realm';
    const roles=await (await admin(rolePath+'/available','GET',200)).json() as {name:string;id:string}[];
    await admin(rolePath,'POST',204,[roles.find(r=>r.name==='platform_admin')]);
    await users.pool.query("insert into app_user(app_user_id,keycloak_sub,role_code) values ($1,$2,'platform_admin')",[platformId,subject]);
    for (const [database, script] of [[users, 'users/upgrade-first-admin.sql'], [clinics, 'clinics/upgrade-registration.sql']] as const) {
      await database.pool.query(readFileSync(new URL('../../../../database/updates/' + script, import.meta.url), 'utf8'));
    }
    const u=await listen(), c=await listen();
    u.server.on('request',createApp({management:{db:users.db,identity},clinicsUrl:c.url}));
    const {createApp:clinicsApp}=await import(new URL('../../../clinics-service/app.ts',import.meta.url).href);
    c.server.on('request',clinicsApp({serviceCatalog:{db:clinics.db},usersUrl:u.url}));
    const platformToken=await signin(username,password);
    const initialPassword=randomUUID(), firstName='first-'+randomUUID();
    const resp=await post(c.url+'/clinics',platformToken,{name:'Clinic',identifier:'J2',timeZone:'America/Costa_Rica',administrator:{username:firstName,initialPassword}});
    assert.equal(resp.status,201);
    const created=await resp.json();
    const [first]=(await users.pool.query('select * from app_user where app_user_id=$1',[created.appUserId])).rows;
    subjects.push(first.keycloak_sub);
    assert.equal(first.clinic_id,created.clinicId);
    assert.equal((await clinics.pool.query('select is_active from clinic where clinic_id=$1',[created.clinicId])).rows[0].is_active,true);
    // Test fixture completes the first-password action, which a person does through Keycloak.
    await admin('/users/'+first.keycloak_sub+'/reset-password','PUT',204,{type:'password',value:password,temporary:false});
    const bearer=await signin(firstName,password);
    const access=JSON.parse(Buffer.from(bearer.split('.')[1]!,'base64url').toString());
    assert.equal(access.clinic_id,created.clinicId);
    assert.equal(access.app_user_id,created.appUserId);
    assert.equal(access.exp-access.iat,300);
    assert.ok(access.realm_access.roles.includes('clinic_admin'));
    const receptionist='rx-'+randomUUID();
    const result=await post(u.url+'/users',bearer,{username:receptionist,initialPassword,role:'receptionist'});
    assert.equal(result.status,201);
    const user=await result.json();
    const [row]=(await users.pool.query('select * from app_user where app_user_id=$1',[user.appUserId])).rows;
    subjects.push(row.keycloak_sub);
    assert.equal(row.clinic_id,created.clinicId);
    const path='/users/'+row.keycloak_sub;
    await admin(path+'/reset-password','PUT',204,{type:'password',value:password,temporary:false});
    const login=await fetch(tokenUrl,{method:'POST',body:new URLSearchParams({grant_type:'password',client_id:'j2-tests',username:receptionist,password})});
    assert.equal(login.status,200);
    const session=await login.json();
    const update=await fetch(u.url+'/users/'+user.appUserId+'/role',{method:'PUT',headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},body:JSON.stringify({role:'professional'})});
    assert.equal(update.status,204);
    const refresh=await fetch(tokenUrl,{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',client_id:'j2-tests',refresh_token:session.refresh_token})});
    assert.equal(refresh.status,400);
    assert.equal((await refresh.json()).error,'invalid_grant');
    const assigned=await (await admin(path+'/role-mappings/realm','GET',200)).json() as {name:string}[];
    assert.ok(assigned.some(r=>r.name==='professional'));
    assert.ok(!assigned.some(r=>r.name==='receptionist'));
    const removed=await fetch(u.url+'/users/'+user.appUserId,{method:'DELETE',headers:{authorization:'Bearer '+bearer}});
    assert.equal(removed.status,204);
    const account=await (await admin(path,'GET',200)).json();
    assert.equal(account.enabled,false);
    assert.equal(account.attributes.professional_id,undefined);
  } finally {
    for (const server of servers) await new Promise<void>(resolve=>server.close(()=>resolve()));
    try {for(const sub of subjects) await identity.remove(sub);}
    finally {await clinics?.drop(); await users.drop();}
  }
},90000);
