import { classify, databaseConfig, saveSignup, mirrorSignup } from '../lib/waitlist.js';

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
  try { databaseConfig(); } catch {
    console.error('waitlist_database_not_configured');
    return res.status(503).json({ error: 'not_configured' });
  }
  let row;
  try { row = await saveSignup(parsed, source); } catch {
    console.error('waitlist_primary_write_failed');
    return res.status(502).json({ error: 'storage_unavailable' });
  }
  // Do not report failure for an Airtable mirror problem after the signup is saved.
  const mirror = await mirrorSignup(row);
  return res.status(200).json({ ok: true, mirror: mirror.synced ? 'synced' : 'pending' });
}
