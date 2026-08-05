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
3. Set your secrets as **Script Properties** — these live in the Apps Script project itself,
   not in the source file, so they're never in git. In the editor: gear icon (**Project
   Settings**) → **Script Properties** → **Add script property**, and add three rows:
   | Property | Value |
   |---|---|
   | `REDCAP_API_URL` | your REDCap instance's API endpoint |
   | `REDCAP_API_TOKEN` | an API token scoped to read `record_id`, `forwarding_status`, `patient_token` |
   | `BASE_EMAIL` | the master inbox address, e.g. `study@gmail.com` |

   (Alternative: fill in real values inside the `setup_()` function in `Code.gs`, select it
   from the function dropdown, click **Run** once — it writes the same three properties. Just
   don't leave real values sitting in `setup_()` if you're going to push this file anywhere;
   revert them to placeholders after running, or edit only your local/deployed copy.)
4. In REDCap, confirm each participant record has:
   - A token field (default name `patient_token`) — a unique access token issued to that
     participant. This is their only credential, so make it a real random string (e.g. 12+
     characters), not something guessable. If your REDCap project names this field something
     else, add an `ACCESS_TOKEN_FIELD` Script Property set to that field's name — otherwise
     leave it unset and the default is used.
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
deployment rather than creating a new one. Script Properties persist across redeployments —
you only need to set them once.

## 2. Wire the frontend to the backend

In [index.html](index.html), find:

```js
const APPS_SCRIPT_URL = 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE';
const STUDY_NAME = 'StudyLink Portal';
```

Replace `APPS_SCRIPT_URL` with the `/exec` URL from step 1, and `STUDY_NAME` with whatever
label this study should show (page title + the small heading above "Sign in"). These two lines
are the only required edits to the frontend.

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

## Running multiple studies

Nothing study-specific is hardcoded in the source — every study-specific value (REDCap
credentials, the inbox address, the token field name, the branding label) is either a Script
Property or one of the two frontend config lines above. To stand up a second study:

1. **Fork or duplicate this repo** — GitHub Pages serves one site per repo (or per branch with
   extra setup), so the simplest path is one repo per study rather than trying to make one
   frontend serve several backends.
2. Create a **new Gmail account** for that study's master inbox, and a **new Apps Script
   project** under it (step 1 above, in full — new Script Properties, new deployment, new
   `/exec` URL).
3. In the new repo's `index.html`, set `APPS_SCRIPT_URL` to the new deployment's URL and
   `STUDY_NAME` to the new study's label.
4. Enable Pages on the new repo (step 3 above).

Each study is fully isolated: separate Gmail inbox, separate REDCap project/token, separate
Apps Script deployment, separate Script Properties, separate Pages site. There's no shared
state between them beyond the shared codebase.

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
- The REDCap token lives in Script Properties (server-side, per-project) — never in the source
  file, never sent to the browser, and never committed to git.
- Gmail scopes granted to the script (read + modify, to mark messages read) are broad by
  necessity — the script account should be a dedicated study inbox, not a personal one.
