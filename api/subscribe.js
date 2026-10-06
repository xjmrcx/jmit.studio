// Receives the one box from the coming-soon page and writes it to Airtable.
// The Airtable token lives only here (Vercel env var) — Airtable tokens cannot
// be scoped per row, so it must never reach the browser.

const BASE_ID = process.env.AIRTABLE_BASE_ID || 'app3NuDbFyX4Ic7Yj';
const TABLE = process.env.AIRTABLE_TABLE || 'Waitlist';

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function classify(raw) {
  const v = String(raw || '').trim();
  if (!v || v.length > 254) return null;
  if (EMAIL.test(v)) return { kind: 'email', value: v.toLowerCase() };
  const d = v.replace(/[^\d]/g, '');
  if (/^[+(\d][\d\s().\-]{6,}$/.test(v) && d.length >= 10 && d.length <= 15) {
    // store in E.164 shape; a bare 10-digit number is assumed US
    return { kind: 'phone', value: d.length === 10 ? `+1${d}` : `+${d}` };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const parsed = classify(body.contact);
  if (!parsed) return res.status(400).json({ error: 'invalid_contact' });

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    console.error('AIRTABLE_TOKEN is not set — sign-up not stored');
    return res.status(500).json({ error: 'not_configured' });
  }

  const source = typeof body.source === 'string' ? body.source.slice(0, 60) : 'jmit.app';

  try {
    const r = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          typecast: true,
          records: [{
            fields: {
              Contact: parsed.value,
              Kind: parsed.kind,
              Created: new Date().toISOString(),
              Source: source,
            },
          }],
        }),
      }
    );

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('airtable rejected the sign-up', r.status, detail.slice(0, 300));
      return res.status(502).json({ error: 'upstream' });
    }
  } catch (err) {
    console.error('airtable request failed', err && err.message);
    return res.status(502).json({ error: 'upstream' });
  }

  return res.status(200).json({ ok: true });
}
