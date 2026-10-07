import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/subscribe.js';
import { classify, databaseConfig, saveSignup, mirrorSignup, pendingSignups, retryPending } from '../lib/waitlist.js';

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

test('endpoint stores in Airtable when the database is not configured', async () => {
  const names=['SUPABASE_URL','SUPABASE_SECRET_KEY','AIRTABLE_TOKEN'];
  const previous=Object.fromEntries(names.map(n=>[n,process.env[n]]));const original=globalThis.fetch;
  try {
    delete process.env.SUPABASE_URL;delete process.env.SUPABASE_SECRET_KEY;process.env.AIRTABLE_TOKEN='token';
    let upserted=null;
    globalThis.fetch=async(url,options)=> {
      assert.equal(url.startsWith('https://api.airtable.com/'),true,'only Airtable is called');
      upserted=JSON.parse(options.body);
      return {ok:true,status:200,json:async()=>({records:[{id:'rec1'}]})};
    };
    const response=await invoke('POST',{contact:row.contact});
    assert.equal(response.code,200);assert.deepEqual(response.payload,{ok:true,store:'airtable'});
    assert.deepEqual(upserted.performUpsert,{fieldsToMergeOn:['Contact']},'a retry must not create a second row');
    assert.equal(upserted.records[0].fields.Contact,row.contact);
    // Airtable unreachable must be reported, never silently accepted.
    globalThis.fetch=async()=>({ok:false,status:500});
    assert.equal((await invoke('POST',{contact:row.contact})).code,502);
    // No store at all is still a refusal, not a pretend success.
    delete process.env.AIRTABLE_TOKEN;
    assert.equal((await invoke('POST',{contact:row.contact})).code,503);
  } finally {
    globalThis.fetch=original;for(const n of names){if(previous[n]===undefined)delete process.env[n];else process.env[n]=previous[n];}
  }
});

// ---------------------------------------------------------------------------
// Added coverage: retry runner, mirror-tracking failure, helper error branches,
// and handler fallback branches. Same fake-credentials / mocked-HTTP approach:
// no live service is ever contacted.
// ---------------------------------------------------------------------------

// Swap in a server environment and a mock global fetch for one handler call,
// then always restore both. Clears related keys first so nothing leaks between tests.
async function withServer(overrides, fetchImpl, run) {
  const names=['SUPABASE_URL','SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY','AIRTABLE_TOKEN','AIRTABLE_BASE_ID','AIRTABLE_TABLE'];
  const previous=Object.fromEntries(names.map(n=>[n,process.env[n]]));
  const original=globalThis.fetch;
  try {
    for (const n of names) delete process.env[n];
    Object.assign(process.env,overrides);
    globalThis.fetch=fetchImpl;
    return await run();
  } finally {
    globalThis.fetch=original;
    for (const n of names) { if (previous[n]===undefined) delete process.env[n]; else process.env[n]=previous[n]; }
  }
}

// --- Item 1: retry runner (scripts/retry-airtable.mjs logic, now retryPending) ---
test('retryPending mirrors the pending queue and reports synced/pending counts', async () => {
  const rows=[{...row,id:'id-1',contact:'a@example.com'},{...row,id:'id-2',contact:'b@example.com'}];
  const result=await retryPending({env,delay:0,request:async(url,options={})=> {
    if (url.startsWith('https://api.airtable.com/')) {
      const contact=JSON.parse(options.body).records[0].fields.Contact;
      return contact==='a@example.com' ? ok({records:[{id:'recA'}]}) : {ok:false,status:500};
    }
    if (options.method==='PATCH') return empty();   // markMirror tracking write
    return ok(rows);                                 // pendingSignups select
  }});
  assert.deepEqual(result,{processed:2,synced:1,pending:1});
});
test('retryPending requires an Airtable token before touching the network', async () => {
  await assert.rejects(retryPending({env:{...env,AIRTABLE_TOKEN:undefined},delay:0,request:async()=>assert.fail('no network expected')}), /AIRTABLE_TOKEN/);
});
test('retryPending on an empty queue reports nothing processed and makes no mirror calls', async () => {
  const result=await retryPending({env,delay:0,request:async(url,options={})=> {
    if (!options.method) return ok([]);             // pendingSignups select
    return assert.fail('no mirror calls for an empty queue');
  }});
  assert.deepEqual(result,{processed:0,synced:0,pending:0});
});
test('retryPending paces between rows using the default delay', async () => {
  // delay>0 with the default sleep exercises the real (brief) pacing path between rows.
  let airtable=0;
  const result=await retryPending({env,limit:1,delay:1,request:async(url,options={})=> {
    if (url.startsWith('https://api.airtable.com/')) { airtable++; return ok({records:[{id:'recP'}]}); }
    if (options.method==='PATCH') return empty();   // markMirror tracking write
    return ok([row]);                               // pendingSignups select
  }});
  assert.equal(result.synced,1);assert.equal(airtable,1);
});

// --- Item 2: durable signup, mirror-tracking write fails (lib/waitlist.js 110-113) ---
test('mirror tracking failure is swallowed because the signup is already durable', async () => {
  const result=await mirrorSignup(row,env,async url=> {
    if (url.startsWith('https://api.airtable.com/')) return ok({records:[{id:'recX'}]});
    throw new Error('tracking patch failed');       // markMirror cannot persist sync state
  });
  assert.deepEqual(result,{synced:false,error:'mirror_tracking_failed'});
});

// --- Item 3: untested helper error branches ---
test('saveSignup throws when a suppressed duplicate cannot be read back', async () => {
  let calls=0;
  await assert.rejects(saveSignup(classify(row.contact),'jmit.app',env,async()=> {calls++;return ok([]);}), /database_missing_signup/);
  assert.equal(calls,2);
});
test('database surfaces only a sanitized upstream code, never the raw message', async () => {
  await assert.rejects(
    saveSignup(classify(row.contact),'jmit.app',env,async()=>({ok:false,status:409,json:async()=>({code:'23505',message:`duplicate ${row.contact}`})})),
    err=> { assert.equal(err.message,'database_http_409_23505'); return true; }
  );
});
test('database rejects an OK response whose body is not valid JSON', async () => {
  await assert.rejects(saveSignup(classify(row.contact),'jmit.app',env,async()=>({ok:true,status:200,json:async()=>{throw new Error('not json');}})), /database_invalid_response/);
});
test('databaseConfig rejects non-supabase hosts and unparseable URLs', () => {
  assert.throws(()=>databaseConfig({...env,SUPABASE_URL:'https://evil.com'}), /not_configured/);
  assert.throws(()=>databaseConfig({...env,SUPABASE_URL:'https://ohrkfrocixzpxkhaknvw.supabase.co.attacker.com'}), /not_configured/);
  assert.throws(()=>databaseConfig({...env,SUPABASE_URL:'not-a-url'}), /not_configured/);
});
test('mirror without an Airtable token records a retryable not_configured state', async () => {
  const result=await mirrorSignup(row,{...env,AIRTABLE_TOKEN:undefined},async(url,options)=> {
    assert.ok(!url.startsWith('https://api.airtable.com/'),'no Airtable call without a token');
    assert.equal(JSON.parse(options.body).airtable_last_error,'airtable_not_configured');
    return empty();
  });
  assert.equal(result.synced,false);assert.equal(result.error,'airtable_not_configured');
});
test('mirror treats an Airtable OK response without a record id as retryable', async () => {
  const result=await mirrorSignup(row,env,async(url,options)=> {
    if (url.startsWith('https://api.airtable.com/')) return ok({records:[]});
    assert.equal(JSON.parse(options.body).airtable_last_error,'airtable_invalid_response');return empty();
  });
  assert.equal(result.error,'airtable_invalid_response');
});
test('mirror records airtable_unreachable when the Airtable request throws', async () => {
  const result=await mirrorSignup(row,env,async(url,options)=> {
    if (url.startsWith('https://api.airtable.com/')) throw new Error('network down');
    assert.equal(JSON.parse(options.body).airtable_last_error,'airtable_unreachable');return empty();
  });
  assert.equal(result.error,'airtable_unreachable');
});

// --- Item 4: handler fallback branches in api/subscribe.js ---
test('endpoint trims a custom source to 60 characters before storing', async () => {
  let storedSource=null;
  await withServer(env,async(url,options)=> {
    if (options.method==='POST') { storedSource=JSON.parse(options.body).source; return ok([row]); }
    if (url.startsWith('https://api.airtable.com/')) return ok({records:[{id:'rec1'}]});
    return empty();
  },()=>invoke('POST',{contact:row.contact,source:'x'.repeat(200)}));
  assert.equal(storedSource,'x'.repeat(60));
});
test('endpoint falls back to Airtable when the server key format is invalid', async () => {
  const res=await withServer(
    {SUPABASE_URL:'https://test.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_…',AIRTABLE_TOKEN:'token'},
    async url=> { assert.ok(url.startsWith('https://api.airtable.com/'),'only Airtable is called'); return ok({records:[{id:'rec1'}]}); },
    ()=>invoke('POST',{contact:row.contact})
  );
  assert.equal(res.code,200);assert.deepEqual(res.payload,{ok:true,store:'airtable'});
});
test('endpoint degrades to a sanitized 502 on an unexpected primary error', async () => {
  // Configured DB, but fetch resolves to a non-Response; the resulting TypeError does not
  // match /^database_/, so the handler must still return storage_unavailable, not crash or leak.
  const res=await withServer(env,async()=>undefined,()=>invoke('POST',{contact:row.contact}));
  assert.equal(res.code,502);assert.deepEqual(res.payload,{error:'storage_unavailable'});
});
test('endpoint degrades to a sanitized 502 on an unexpected Airtable-only error', async () => {
  // DB unconfigured → Airtable-only path; a non-Response makes writeAirtableOnly throw a
  // non-airtable_* error, exercising the handler's generic fallback (not a 503 not_configured).
  const res=await withServer({AIRTABLE_TOKEN:'token'},async()=>undefined,()=>invoke('POST',{contact:row.contact}));
  assert.equal(res.code,502);assert.deepEqual(res.payload,{error:'storage_unavailable'});
});
