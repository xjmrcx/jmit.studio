create table public.waitlist_signups (
  id uuid primary key default gen_random_uuid(),
  contact text not null unique check (char_length(contact) between 3 and 254),
  kind text not null check (kind in ('email', 'phone')),
  source text not null default 'jmit.app' check (char_length(source) <= 60),
  created_at timestamptz not null default now(),
  airtable_sync_state text not null default 'pending' check (airtable_sync_state in ('pending', 'failed', 'synced')),
  airtable_attempts integer not null default 0 check (airtable_attempts >= 0),
  airtable_last_attempt_at timestamptz,
  airtable_last_error text,
  airtable_record_id text,
  airtable_synced_at timestamptz,
  constraint contact_matches_kind check (
    (kind = 'email' and contact = lower(contact) and contact ~ '^[^[:space:]@]+@[^[:space:]@]+\.[A-Za-z]{2,}$')
    or (kind = 'phone' and contact ~ '^\+[1-9][0-9]{9,14}$')
  )
);

comment on table public.waitlist_signups is 'jmit.app signup source of truth; Airtable is a retryable mirror, not primary storage.';
create index waitlist_pending_airtable on public.waitlist_signups (created_at) where airtable_sync_state <> 'synced';

alter table public.waitlist_signups enable row level security;
-- No browser/anonymous access. Only the Vercel function's server credential may write.
revoke all on table public.waitlist_signups from public, anon, authenticated;
revoke all on table public.waitlist_signups from service_role;
grant select, insert, update on table public.waitlist_signups to service_role;
