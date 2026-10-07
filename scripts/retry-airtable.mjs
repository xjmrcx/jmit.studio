import { retryPending } from '../lib/waitlist.js';

// Load server-only environment values in your terminal; never put them in Git.
// Each invocation processes at most 100 records, sequentially to respect Airtable limits.
const result = await retryPending();
console.log(JSON.stringify(result));
if (result.synced !== result.processed) process.exitCode = 1;
