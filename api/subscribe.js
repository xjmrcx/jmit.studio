import { classify, databaseConfig, saveSignup, mirrorSignup, writeAirtableOnly } from '../lib/waitlist.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const parsed = classify(body?.contact);
  if (!parsed) return res.status(400).json({ error: 'invalid_contact' });
  const source = typeof body?.source === 'string' ? body.source.slice(0, 60) : 'jmit.app';
  // Supabase is preferred, but a signup must never be lost because it is
  // unavailable: fall back to Airtable as the store rather than refusing.
  let database = true;
  try { databaseConfig(); } catch (error) {
    database = false;
    console.error('waitlist_database_not_configured', error?.message === 'invalid_server_key_format' ? 'invalid_server_key_format' : 'missing_configuration');
  }
  if (!database) {
    try {
      await writeAirtableOnly(parsed, source);
    } catch (error) {
      const code = /^airtable_[A-Za-z0-9_]+$/.test(error?.message || '') ? error.message : 'airtable_unknown';
      console.error('waitlist_airtable_only_write_failed', code);
      return res.status(code === 'airtable_not_configured' ? 503 : 502)
        .json({ error: code === 'airtable_not_configured' ? 'not_configured' : 'storage_unavailable' });
    }
    return res.status(200).json({ ok: true, store: 'airtable' });
  }
  let row;
  try { row = await saveSignup(parsed, source); } catch (error) {
    const code = /^database_[A-Za-z0-9_]+$/.test(error?.message || '') ? error.message : 'database_unknown';
    console.error('waitlist_primary_write_failed', code);
    return res.status(502).json({ error: 'storage_unavailable' });
  }
  // Do not report failure for an Airtable mirror problem after the signup is saved.
  const mirror = await mirrorSignup(row);
  return res.status(200).json({ ok: true, mirror: mirror.synced ? 'synced' : 'pending' });
}
