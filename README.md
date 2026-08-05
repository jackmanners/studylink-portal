# StudyLink Portal

A free, self-hosted system for study participants to log in and retrieve
authentication codes sent to device-specific Gmail aliases
(`study+001@gmail.com`, `study+002@gmail.com`, ...).

- **Frontend** ([index.html](index.html)): static single-page app, hosted free on GitHub Pages.
- **Backend** ([backend/Code.gs](backend/Code.gs)): Google Apps Script Web App. Talks to the master
  Gmail inbox and the REDCap API. Holds the REDCap token — never exposed to the browser.

## 1. Deploy the Apps Script backend

1. Go to [script.google.com](https://script.google.com) and create a new project, using the
   Gmail account that will act as the master inbox (the one receiving `+alias` mail).
2. Delete the default `Code.gs` contents and paste in [backend/Code.gs](backend/Code.gs).
3. At the top of the file, fill in:
   - `REDCAP_API_URL` — your REDCap instance's API endpoint.
   - `REDCAP_API_TOKEN` — an API token scoped to read `record_id`, `forwarding_status`, and
     `patient_token`.
   - `BASE_EMAIL` — the master inbox address, e.g. `study@gmail.com`.
4. In REDCap, confirm each participant record has:
   - `patient_token` — a unique access token issued to that participant. This is their only
     credential, so make it a real random string (e.g. 12+ characters), not something guessable.
   - `forwarding_status` — set to `1` once their device alias is active.
5. Click **Deploy → New deployment**.
   - Type: **Web app**.
   - Execute as: **Me**.
   - Who has access: **Anyone**.
6. Authorize the requested scopes (Gmail read/modify, external requests) — this is your own
   account, so this is expected.
7. Copy the deployment's **Web app URL** (ends in `/exec`). You'll need it in step 2.

You can redeploy (Deploy → Manage deployments → Edit → New version) any time you change the
script; the `/exec` URL stays the same across versions as long as you edit the existing
deployment rather than creating a new one.

## 2. Wire the frontend to the backend

In [index.html](index.html), find:

```js
const APPS_SCRIPT_URL = 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE';
```

Replace the placeholder with the `/exec` URL from step 1.

## 3. Host the frontend on GitHub Pages

1. Push this repo to GitHub (public or private — Pages works on both, private repos need
   GitHub Pro/Team/Enterprise for Pages, so public is the free option).
   ```bash
   git remote add origin https://github.com/<you>/studylink-portal.git
   git push -u origin main
   ```
2. In the GitHub repo: **Settings → Pages**.
3. Under **Build and deployment**, set **Source: Deploy from a branch**.
4. Branch: `main`, folder: `/ (root)`. Save.
5. GitHub will publish at `https://<you>.github.io/studylink-portal/` within a minute or two.

Participants use that URL on their device to log in and fetch their code.

## Security notes (read before enrolling real participants)

- **The access token is the only credential.** The frontend has no Participant ID field —
  `verify` looks the participant up in REDCap by `patient_token` via `filterLogic`. This means
  the token's strength *is* the system's security: issue random, non-guessable tokens (e.g.
  12+ alphanumeric characters), not short PINs or anything derived from the participant ID.
- A per-token lockout (5 failed verifies / 10 minutes) is built in via `CacheService`, but it
  can't rate-limit by IP — Apps Script doesn't expose the caller's address.
- After a successful `verify`, the token is authorized to call `fetchCode` for 5 minutes
  (`SESSION_TTL_SEC`) without re-querying REDCap, so the 2-minute polling loop doesn't hammer
  the REDCap API.
- The REDCap token lives only in `Code.gs`, server-side; it's never sent to the browser.
- Gmail scopes granted to the script (read + modify, to mark messages read) are broad by
  necessity — the script account should be a dedicated study inbox, not a personal one.
