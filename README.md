# jmit.app — coming soon

A static page and a serverless signup function. No framework, build step, or runtime dependencies.

## Dedicated services

- GitHub: `xjmitx/jmit.app`, production branch `main`.
- Vercel: team `jmxit`, project `jmit-app`; **repository root**, framework **Other**, no build/output command.
- Supabase: project **jmit.app**, ref `ohrkfrocixzpxkhaknvw`, in the separate **jmit.app Free-plan organization** (`hskkmsgcgpynuznymrjk`). Do not use the WiCare database.
- Airtable mirror: **@jmit.app** (`app3NuDbFyX4Ic7Yj`), table **Waitlist**.

Supabase Free has usage limits and may pause after inactivity. Free does not mean unlimited or the same availability guarantees as a paid project. Do not upgrade plans or purchase add-ons without the owner's approval.

## Signup flow

`POST /api/subscribe` accepts `{ "contact": "email or phone", "source": "jmit.app" }`.

1. The server validates and normalizes the contact independently of the browser. Email is lowercased; a bare 10-digit number is assumed US and saved as `+1…`.
2. The server stores the signup in private Supabase table `public.waitlist_signups`. A unique contact constraint makes repeated submissions idempotent.
3. It upserts an Airtable row by **Contact**, carrying **Kind**, **Created**, and **Source**. This makes retries safe when a response is lost.
4. A primary-storage failure returns an error and the page says the signup failed. An Airtable failure after a successful database write returns success and leaves a retryable `failed` mirror state. A missing Airtable token also leaves a retryable record.

The database tracks `airtable_sync_state`, attempts, last attempt/error, record ID, and sync time. Error logs contain operational codes, not contact values or credentials.

## Server environment

Add these to Vercel Production, Preview, and Development. Never prefix these keys with `VITE_` or put them in `index.html`, screenshots, chat, or Git.

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | `https://ohrkfrocixzpxkhaknvw.supabase.co` |
| `SUPABASE_SECRET_KEY` | Modern `sb_secret_…` server key from the **jmit.app** project; keep as a Vercel Secret |
| `SUPABASE_SERVICE_ROLE_KEY` | Optional legacy alternative to `SUPABASE_SECRET_KEY`, not needed when a modern secret key is set |
| `AIRTABLE_TOKEN` | Write-only token restricted to **@jmit.app**; keep as a Vercel Secret |
| `AIRTABLE_BASE_ID` | `app3NuDbFyX4Ic7Yj` (also the default) |
| `AIRTABLE_TABLE` | `Waitlist` (also the default) |

A Supabase publishable/anon key is **not sufficient** for this server-only write path. Modern secret keys authenticate using the `apikey` header; a legacy service-role JWT also uses Bearer authorization.

The migration in `supabase/migrations/` enables RLS and gives **no anonymous or signed-in browser access** to signup records. Only the server role has SELECT, INSERT, UPDATE. There is no public list or export endpoint.

## Airtable retry

There is **no automatic background retry schedule** configured. Resubmitting the same contact retries an unsynced mirror. An operator can retry up to 100 pending records per invocation:

```sh
# Load the server environment securely in the terminal first; do not paste secrets into command history.
npm run mirror:retry
```

The command runs sequentially, respects basic Airtable pacing, and reports counts only. Run it again for another batch after checking errors. It requires the same Supabase server key and Airtable token as the function.

## Verification

```sh
npm test
node --check api/subscribe.js
```

Tests use fake credentials and mocked HTTP; they do not write live signup records. Before public launch, verify a real email and phone submission in Supabase and Airtable, and verify failure behavior. Keep preview deployments protected until launch is approved.

## Files

- `index.html`: existing JMIT page; inline CSS/JS unchanged.
- `logo.svg`, `favicon.svg`: existing visual assets.
- `api/subscribe.js`: Supabase-first endpoint.
- `lib/waitlist.js`: server-only storage and mirror helpers.
- `scripts/retry-airtable.mjs`: bounded manual retry.
- `supabase/migrations/`: versioned private-table schema.
- `test/subscribe.test.js`: backend regression tests.
- `vercel.json`: clean URLs and security headers.

To preview the static page alone, run a local HTTP server. The form requires a Vercel function and its server environment. For a full local function environment, use `vercel dev` with securely configured values.
