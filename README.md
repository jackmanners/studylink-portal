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
   - A forwarding-status field (default name `forwarding_status`, override via a
     `FORWARDING_STATUS_FIELD` Script Property) — set to `1` once a participant's device
     alias is active. Login is rejected while this isn't `1`.
   - A device email field (default name `device_email`, override via a `DEVICE_EMAIL_FIELD`
     Script Property) — must exist in the project even if it's usually left blank. When a
     record has a value here, the backend searches that exact address for the code instead of
     deriving `BASE_EMAIL`'s `+recordId` alias — for participants whose device forwards to a
     full address of its own rather than a shared inbox alias.
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

## 2. Register the study in studies.json

One frontend deployment can serve any number of studies. Which study a visitor lands on is
picked by a `?study=slug` query parameter, resolved at page load against
[studies.json](studies.json) — a plain public map of slug → Apps Script URL + display name:

```json
{
  "samma": {
    "name": "SAMMA Study",
    "appsScriptUrl": "https://script.google.com/macros/s/.../exec"
  }
}
```

Add an entry for your study (pick any URL-safe slug), using the `/exec` URL from step 1. Give
each participant the link `https://<you>.github.io/studylink-portal/?study=<slug>` — nothing
else in the frontend needs to change per study.

`studies.json` is public, same as the rest of this repo — see "Running multiple studies" below
for the tradeoff that implies.

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

A single Pages deployment can serve every study. Nothing in `index.html` is study-specific —
it resolves `?study=slug` against `studies.json` at load time and fails gracefully with a
"Study not found" message if the slug is missing or unknown. To add a new study:

1. Create a **new Gmail account** for that study's master inbox, and a **new Apps Script
   project** under it (step 1 above, in full — its own Script Properties, its own deployment,
   its own `/exec` URL).
2. Add one entry to `studies.json` with that URL and push. No frontend redeploy step beyond
   the git push — GitHub Pages picks it up automatically.
3. Send participants the link with that study's slug: `.../?study=<slug>`.

Each study's **backend** stays fully isolated — separate Gmail inbox, separate REDCap
project/token, separate Apps Script deployment, separate Script Properties, separate
per-token lockout and session cache (Apps Script's `CacheService` is scoped per-project, so
studies can't collide there either).

The one thing that *is* shared is `studies.json` itself: it's a single public file listing
every active study's Apps Script URL and name side by side. That's a low-severity exposure —
the URLs aren't secrets, and `patient_token` still gates each study independently — but it does
mean anyone who finds this repo can see the full list of studies it's currently serving, and a
mistake in one study's `Code.gs`/REDCap setup doesn't affect others, but a mistake in
`studies.json` (wrong URL) does. If your institution's review process wants studies fully
compartmentalized instead — separate repos, separate Pages sites, no shared registry — fork
this repo per study and hardcode `APPS_SCRIPT_URL`/`STUDY_NAME` directly in `index.html`
instead of using `studies.json`.

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
