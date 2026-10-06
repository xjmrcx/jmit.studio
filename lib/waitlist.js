// Server-only helpers. Never import into the public page.
const COLUMNS = 'id,contact,kind,created_at,source,airtable_sync_state,airtable_attempts';
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function classify(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 254) return null;
  if (EMAIL.test(value)) return { kind: 'email', value: value.toLowerCase() };
  const digits = value.replace(/[^\d]/g, '');
  if (/^[+(\d][\d\s().\-]{6,}$/.test(value) && digits.length >= 10 && digits.length <= 15) {
    const normalized = digits.length === 10 ? `+1${digits}` : `+${digits}`;
    return /^\+[1-9][0-9]{9,14}$/.test(normalized) ? { kind: 'phone', value: normalized } : null;
  }
  return null;
}

export function databaseConfig(env = process.env) {
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !key) throw new Error('not_configured');
  let url;
  try { url = new URL(env.SUPABASE_URL); } catch { throw new Error('not_configured'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co')) throw new Error('not_configured');
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  // Modern sb_secret keys authenticate through apikey, not a JWT Bearer header.
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  return { url: url.origin, headers };
}

async function database(path, options = {}, env = process.env, request = fetch) {
  const config = databaseConfig(env);
  let response;
  try {
    response = await request(`${config.url}/rest/v1/${path}`, {
      ...options, headers: { ...config.headers, ...options.headers }, signal: AbortSignal.timeout(8000),
    });
  } catch { throw new Error('database_unreachable'); }
  if (!response.ok) throw new Error(`database_http_${response.status}`);
  if (response.status === 204) return null;
  try { return await response.json(); } catch { throw new Error('database_invalid_response'); }
}

export async function saveSignup(parsed, source, env = process.env, request = fetch) {
  // The unique contact constraint prevents duplicate signups, including concurrent requests.
  const result = await database(`waitlist_signups?on_conflict=contact&select=${COLUMNS}`, {
    method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ contact: parsed.value, kind: parsed.kind, source }),
  }, env, request);
  if (Array.isArray(result) && result[0]) return result[0];
  const query = new URLSearchParams({ contact: `eq.${parsed.value}`, select: COLUMNS, limit: '1' });
  const existing = await database(`waitlist_signups?${query}`, {}, env, request);
  if (!Array.isArray(existing) || !existing[0]) throw new Error('database_missing_signup');
  return existing[0];
}

async function markMirror(row, changes, env, request) {
  const query = new URLSearchParams({ id: `eq.${row.id}` });
  await database(`waitlist_signups?${query}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(changes),
  }, env, request);
}

export async function mirrorSignup(row, env = process.env, request = fetch) {
  if (row.airtable_sync_state === 'synced') return { synced: true };
  const attempts = (row.airtable_attempts || 0) + 1;
  let error = null;
  let airtableId = null;
  if (!env.AIRTABLE_TOKEN) error = 'airtable_not_configured';
  else {
    try {
      const base = env.AIRTABLE_BASE_ID || 'app3NuDbFyX4Ic7Yj';
      const table = env.AIRTABLE_TABLE || 'Waitlist';
      const response = await request(`https://api.airtable.com/v0/${encodeURIComponent(base)}/${encodeURIComponent(table)}`, {
        method: 'PATCH', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          performUpsert: { fieldsToMergeOn: ['Contact'] }, typecast: true,
          records: [{ fields: { Contact: row.contact, Kind: row.kind, Created: row.created_at, Source: row.source } }],
        }),
      });
      if (!response.ok) error = `airtable_http_${response.status}`;
      else {
        const payload = await response.json();
        airtableId = payload.records?.[0]?.id;
        if (!airtableId) error = 'airtable_invalid_response';
      }
    } catch { error = 'airtable_unreachable'; }
  }
  try {
    await markMirror(row, {
      airtable_sync_state: error ? 'failed' : 'synced', airtable_attempts: attempts,
      airtable_last_attempt_at: new Date().toISOString(), airtable_last_error: error,
      ...(error ? {} : { airtable_record_id: airtableId, airtable_synced_at: new Date().toISOString() }),
    }, env, request);
  } catch {
    // Signup is already durable. A later upsert safely retries the mirror without duplicates.
    console.error('waitlist_mirror_tracking_failed');
    return { synced: false, error: 'mirror_tracking_failed' };
  }
  if (error) console.error('waitlist_mirror_pending', error);
  return { synced: !error, error };
}

export async function pendingSignups(limit = 100, env = process.env, request = fetch) {
  const query = new URLSearchParams({ select: COLUMNS, airtable_sync_state: 'neq.synced', order: 'created_at.asc', limit: String(Math.min(Math.max(limit, 1), 100)) });
  return database(`waitlist_signups?${query}`, {}, env, request);
}
