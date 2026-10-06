# jmit.app — coming soon

One static page plus one serverless function. No build step, no framework.

```
index.html        the page (all CSS and JS inline)
logo.svg          the JMIT mark, rebuilt as vector, transparent background
favicon.svg       the mark on a black rounded square
api/subscribe.js  POST { contact, kind, source } → Airtable
vercel.json       clean URLs + security headers (CSP allows only this origin)
```

## The one box

The field takes an email address **or** a phone number; the page decides which
and tells the server. Phone numbers are stored in E.164 (`+17875550134`); a bare
10-digit number is assumed US. The same check runs again in `api/subscribe.js` —
the browser's answer is never trusted.

## Airtable

Base **@jmit.app** (`app3NuDbFyX4Ic7Yj`), table **Waitlist**:
`Contact` · `Kind` (email/phone) · `Created` · `Source` · `Notes`.

The token lives **only** in the function's environment. Airtable tokens cannot be
scoped per row, so it must never be shipped to the browser.

| Env var | Required | Default |
|---|---|---|
| `AIRTABLE_TOKEN` | yes | — |
| `AIRTABLE_BASE_ID` | no | `app3NuDbFyX4Ic7Yj` |
| `AIRTABLE_TABLE` | no | `Waitlist` |

Make the token at airtable.com/create/tokens with scope `data.records:write`
limited to the **@jmit.app** base, then add it in Vercel → Settings →
Environment Variables. Until it is set the function returns 500 and the page
says the sign-up didn't go through — nothing is silently dropped.

## Replacing the logo

Drop your own `logo.svg` (or `logo.png`) next to `index.html`. The page probes
for the file off-DOM, so a missing file never leaves a broken image — it falls
back to a typographic `JMIT` wordmark.

## Running it locally

`npx vercel dev` (needs the env var), or `python3 -m http.server` for the page
alone — the form will fail without the function, which is the expected path.
