import { databaseConfig, pendingSignups, mirrorSignup } from '../lib/waitlist.js';

// Load server-only environment values in your terminal; never put them in Git.
// Each invocation processes at most 100 records, sequentially to respect Airtable limits.
databaseConfig();
if (!process.env.AIRTABLE_TOKEN) throw new Error('AIRTABLE_TOKEN is required for retry');
const rows = await pendingSignups(100);
let synced = 0;
for (const row of rows) {
  if ((await mirrorSignup(row)).synced) synced++;
  await new Promise(resolve => setTimeout(resolve, 250));
}
console.log(JSON.stringify({ processed: rows.length, synced, pending: rows.length - synced }));
if (synced !== rows.length) process.exitCode = 1;
