# StudyLink Portal

A free, self-hosted system for study participants to log in and retrieve
authentication codes sent to device-specific Gmail aliases
(`study+001@gmail.com`, `study+002@gmail.com`, ...).

- **Frontend** ([index.html](index.html)): static single-page app, hosted free on GitHub Pages.
- **Backend** ([backend/Code.gs](backend/Code.gs)): Google Apps Script Web App. Talks to a Gmail
  inbox and the REDCap API. Holds the REDCap token — never exposed to the browser. Supports two
  modes: a study's own dedicated inbox (default), or a shared **hub** that other researchers
  forward their mail into without handing over account access — see "Hub mode" below.

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

**Checking a deployment is set up correctly:** the frontend's "Check system status" link (on
the sign-in screen) calls a `healthCheck` action that needs no token — it confirms Script
Properties are set, that REDCap is reachable and all four configured field names actually
exist there, and that the script can read Gmail. Use it after every new deployment instead of
debugging through a participant-facing error.

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

## Hub mode: hosting a study whose Gmail you don't control

Everything above assumes you (or someone on your team) can create an Apps Script project
*inside* the study's own Gmail account. That's not always true — a colleague running their own
study may want to use this system without handing over account access, or without doing any
Apps Script setup themselves at all.

**Hub mode solves this with Gmail's own mail forwarding, not account delegation.** One Apps
Script deployment (the "hub" — typically your existing dedicated deployment, or a fresh one)
can additionally host any number of *forwarded* studies:

1. The other researcher keeps their own Gmail exactly as-is. In their Gmail settings, they add
   your hub's Gmail address as a **forwarding address** (Settings → Forwarding and POP/IMAP →
   Add a forwarding address), which sends a one-time verification email to the hub inbox —
   someone with hub access clicks the confirmation link once.
2. They create a **filter** in their own Gmail matching their device-verification pattern
   (e.g. `to:(theirprefix+*)`) with the action "Forward it to" your hub, targeting a **relay
   alias** unique to their study — a plus-address on the hub's own account, e.g.
   `yourhub+theirslug@gmail.com`. Nothing else about their inbox changes, and they can delete
   the filter at any time to stop it — no token or account access to revoke on your end.
3. On the hub, run `registerStudy_()` in `Code.gs` once (see the template function — fill in
   their REDCap URL/token, their own Gmail address as `baseEmail`, and the relay alias you
   agreed on, then run it from the Apps Script editor's function dropdown). This writes one
   `STUDY_<SLUG>` Script Property containing that study's config as JSON.
4. Add an entry to `studies.json` for their slug, pointing `appsScriptUrl` at the **hub's**
   `/exec` URL (the same URL as any other study already hosted there).
5. Give them the same `?study=<slug>` link as any other study. The frontend already sends the
   slug on every request (used for routing on the hub), so nothing else changes for
   participants.

**How the hub tells participants apart.** The relay alias only narrows a search down to "mail
for this study" — many participants share it. Gmail's *automatic* forwarding (via Settings or
a Filter's "Forward it to" action) is a true SMTP relay: it preserves the original message's
`To:` header rather than rewriting it, unlike a human manually clicking "Forward" in the Gmail
UI (which wraps everything in a new message and loses the original headers). The hub reads that
preserved header to work out which participant's original alias (`theirprefix+recordId@theirgmail.com`,
computed from the `baseEmail` in that study's config, exactly as in dedicated mode) a forwarded
message actually belongs to. **Worth confirming this empirically with a real test send** before
relying on it for a study — send a test verification email through the researcher's filter and
check it via "Check system status," since exact header-preservation behavior isn't something
Google documents in detail and could have edge cases.

**Mixing modes.** A single deployment can serve its own dedicated study (flat Script
Properties, unchanged) *and* any number of hub studies (`STUDY_<SLUG>` properties)
simultaneously — `getConfig_()` picks the right one per-request based on the `study` slug sent
by the frontend, falling back to the dedicated/flat config if no matching `STUDY_<SLUG>` exists.
Existing dedicated deployments need no changes to keep working exactly as before.

**Removing a hub study:** run `unregisterStudy_()` with the right slug, and remove its
`studies.json` entry.

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
- `fetchCode` returns up to the 10 most recent matching emails (not just unread ones) within
  the last day, so a participant can see prior codes if more than one arrived — the frontend
  shows the newest prominently and the rest behind an auto-expand/collapse toggle. This means
  a verified session can see everything sent to that device's address in the last day, not
  just a single one-time code.
- The Gmail search covers `in:anywhere` (including Spam and Trash), not just Inbox — third-party
  device-vendor mail is exactly the kind of thing Gmail sometimes misfires on, and a code
  silently landing in Spam would otherwise look like total failure with nothing to debug.
- `healthCheck` is a public, unauthenticated action (anyone with the deployment URL can call
  it) by design, so it deliberately returns only pass/fail booleans and short diagnostic
  strings — never the actual REDCap token, URL, or other secret values.
- **Hub mode concentrates trust in the hub's Gmail owner.** Forwarded studies' verification
  emails land in the hub's own inbox (that's how forwarding works), so whoever controls that
  Google account can technically read every forwarded study's mail, same as they already could
  for their own dedicated study. This is the tradeoff of not requiring account handover — the
  researcher never shares their own Gmail, but they are trusting the hub operator with copies
  of their participants' verification mail. Make sure that's an acceptable tradeoff for your
  institution's data-handling requirements before offering hub mode to other researchers.
- A `STUDY_<SLUG>` hub config's REDCap token is only as safe as the hub deployment's own Script
  Properties — same protection as dedicated mode (never in source, never sent to the browser),
  but now multiple studies' REDCap tokens live in one project's property store instead of being
  split across separate Apps Script projects.
