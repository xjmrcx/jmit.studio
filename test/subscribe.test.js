import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/subscribe.js';
import { classify, databaseConfig, saveSignup, mirrorSignup, pendingSignups } from '../lib/waitlist.js';

const env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_fake', AIRTABLE_TOKEN: 'fake-token' };
const row = { id: '00000000-0000-4000-8000-000000000001', contact: 'test@example.com', kind: 'email', source: 'jmit.app', created_at: '2026-10-06T00:00:00Z', airtable_sync_state: 'pending', airtable_attempts: 0 };
const ok = data => ({ ok: true, status: 200, json: async () => data });
const empty = () => ({ ok: true, status: 204 });
async function invoke(method, body) {
  const res = { code: 0, headers: {}, setHeader(k,v) { this.headers[k] = v; }, status(c) { this.code=c; return this; }, json(p) { this.payload=p; return this; } };
  await handler({method,body},res); return res;
}

// These tests use fake credentials and fake HTTP responses, never the live services.
test('contact classification normalizes email and US/explicit international phone', () => {
  assert.deepEqual(classify(' TEST@EXAMPLE.COM '), {kind:'email',value:'test@example.com'});
  assert.deepEqual(classify('(787) 555-0134'), {kind:'phone',value:'+17875550134'});
  assert.deepEqual(classify('+44 20 7946 0958'), {kind:'phone',value:'+442079460958'});
  for (const value of ['', 'wrong', '123', '+00000000000', {}, 'a'.repeat(255)]) assert.equal(classify(value), null);
});
test('modern secret uses apikey only; legacy service-role uses Bearer', () => {
  assert.equal(databaseConfig(env).headers.Authorization, undefined);
  assert.equal(databaseConfig({...env,SUPABASE_SECRET_KEY:'legacy.jwt.key'}).headers.Authorization,'Bearer legacy.jwt.key');
  assert.equal(databaseConfig({...env,SUPABASE_SECRET_KEY:'  sb_secret_fake\n'}).headers.apikey,'sb_secret_fake');
  assert.throws(()=>databaseConfig({}), /not_configured/);
  assert.throws(()=>databaseConfig({...env,SUPABASE_URL:'http://localhost'}), /not_configured/);
  for (const key of ['sb_secret_…', 'sb_secret_********', 'sb_publishable_fake']) {
    assert.throws(()=>databaseConfig({...env,SUPABASE_SECRET_KEY:key}), /invalid_server_key_format/);
  }
});
test('network errors expose only a machine code, not raw error text', async () => {
  await assert.rejects(saveSignup(classify(row.contact),'jmit.app',env,async()=> {
    const error = new Error('private upstream detail'); error.cause={code:'ENOTFOUND'}; throw error;
  }), /database_unreachable_ENOTFOUND/);
});
test('primary insert requests only necessary columns and suppresses duplicates', async () => {
  await saveSignup(classify(row.contact),'jmit.app',env,async (url,options)=> {
    assert.match(url,/select=id,contact,kind/);
    assert.match(options.headers.Prefer,/ignore-duplicates/);
    assert.deepEqual(JSON.parse(options.body),{contact:row.contact,kind:'email',source:'jmit.app'});
    return ok([row]);
  });
});
test('duplicate signup reads one existing row rather than creating another', async () => {
  let calls=0;
  const found=await saveSignup(classify(row.contact),'jmit.app',env,async url=> {
    if (++calls===1) return ok([]);
    assert.equal(new URL(url).searchParams.get('limit'),'1'); return ok([row]);
  });
  assert.equal(found.id,row.id);assert.equal(calls,2);
});
test('successful mirror upserts by Contact and records sync status', async () => {
  let calls=0;
  const result=await mirrorSignup(row,env,async(url,options)=> {
    calls++;
    const body=JSON.parse(options.body);
    if (url.startsWith('https://api.airtable.com/')) {
      assert.equal(options.method,'PATCH');assert.deepEqual(body.performUpsert.fieldsToMergeOn,['Contact']);
      assert.equal(body.records[0].fields.Created,row.created_at);return ok({records:[{id:'recTest'}]});
    }
    assert.equal(body.airtable_sync_state,'synced');assert.equal(body.airtable_record_id,'recTest');return empty();
  });
  assert.equal(result.synced,true);assert.equal(calls,2);
});
test('mirror rejection tracks a retryable error without throwing', async () => {
  const result=await mirrorSignup(row,env,async(url,options)=> {
    if(url.startsWith('https://api.airtable.com/')) return {ok:false,status:403};
    const body=JSON.parse(options.body);assert.equal(body.airtable_sync_state,'failed');assert.equal(body.airtable_last_error,'airtable_http_403');return empty();
  });assert.equal(result.synced,false);
});
test('already synced records skip Airtable', async () => {
  const result=await mirrorSignup({...row,airtable_sync_state:'synced'},env,async()=>assert.fail('unexpected HTTP'));
  assert.equal(result.synced,true);
});
test('manual retry reads a bounded private queue', async () => {
  await pendingSignups(1000,env,async url=>{assert.equal(new URL(url).searchParams.get('limit'),'100');return ok([]);});
});
test('endpoint checks methods and malformed input without network calls', async () => {
  assert.equal((await invoke('GET',{})).code,405);
  assert.equal((await invoke('POST','{invalid')).code,400);
  assert.equal((await invoke('POST',{contact:'bad'})).code,400);
});
test('endpoint reports primary storage failure but accepts a durable signup on mirror failure', async () => {
  const names=['SUPABASE_URL','SUPABASE_SECRET_KEY','AIRTABLE_TOKEN'];
  const previous=Object.fromEntries(names.map(n=>[n,process.env[n]]));const original=globalThis.fetch;
  try {
    Object.assign(process.env,env);
    globalThis.fetch=async()=>({ok:false,status:503});
    assert.equal((await invoke('POST',{contact:row.contact})).code,502);
    let durable=false;
    globalThis.fetch=async(url,options)=> {
      if(options.method==='POST'){durable=true;return ok([row]);}
      if(url.startsWith('https://api.airtable.com/')){assert.equal(durable,true);return {ok:false,status:503};}
      return empty();
    };
    const response=await invoke('POST',{contact:row.contact});
    assert.equal(response.code,200);assert.deepEqual(response.payload,{ok:true,mirror:'pending'});assert.equal(response.headers['Cache-Control'],'no-store');
  } finally {
    globalThis.fetch=original;for(const n of names){if(previous[n]===undefined)delete process.env[n];else process.env[n]=previous[n];}
  }
});
