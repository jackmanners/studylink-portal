# StudyLink Portal

A free, self-hosted system for study participants to log in and retrieve
authentication codes sent to device-specific Gmail aliases
(`study+001@gmail.com`, `study+002@gmail.com`, ...).

- **Frontend** ([index.html](index.html)): static single-page app, hosted free on GitHub Pages.
- **Backend** ([backend/Code.gs](backend/Code.gs)): Google Apps Script Web App. Talks to REDCap and
  a Gmail inbox. Holds REDCap credentials — never exposed to the browser, never in `studies.json`,
  never in git.

Every study — whether its own Gmail account runs this script directly, or its mail is forwarded
in from a researcher who never shares account access — is registered the same way: one
`STUDY_<BASE>` entry in the backend's Script Properties. There's a single mechanism, not two
separate ones; see "Registering a study" below.

## 1. Deploy the Apps Script backend

1. Go to [script.google.com](https://script.google.com) and create a new project. Which Gmail
   account you're logged into matters (see step 3) — for a study whose Gmail you already
   control, use that account; otherwise any account you control works (it becomes the "hub").
2. Delete the default `Code.gs` contents and paste in [backend/Code.gs](backend/Code.gs).
3. Click **Deploy → New deployment** → Type: **Web app** → Execute as: **Me** → Who has
   access: **Anyone** → **Deploy**. Authorize the requested scopes (Gmail read/modify, external
   requests) — this is your own account, so this is expected.
4. Copy the deployment's **Web app URL** (ends in `/exec`). You'll need it below.

You can redeploy (Deploy → Manage deployments → pencil icon → New version) any time you change
the script; the `/exec` URL stays the same across versions as long as you edit the existing
deployment rather than creating a new one. Script Properties persist across redeployments.

## 2. Register a study

Every study is one Script Property, `STUDY_<BASE>` (uppercased), holding a JSON blob — added by
filling in and running `registerStudy_()` in `Code.gs` from the Apps Script editor's function
dropdown. `base` is the value that ties everything together: it's what goes in `studies.json`,
what participants' links carry as `?base=`, and (for the common case) the literal Gmail
username whose plus-addresses (`base+recordId@gmail.com`) participants' devices send codes to.

**Case A — this script's own Gmail account is the study's inbox** (the common case; this is
how SAMMA works). Set `base` to exactly match this account's own Gmail username — e.g. if this
script is running under `samma.study@gmail.com`, `base` is `"samma.study"`. Leave
`forwarded: false` and omit `baseEmail` entirely; there's nothing else Gmail-related to
configure, since the account *is* `base@gmail.com` by definition.

```js
function registerStudy_() {
  const base = 'samma.study';
  PropertiesService.getScriptProperties().setProperty(
    'STUDY_' + base.toUpperCase(),
    JSON.stringify({
      redcapApiUrl: 'https://researchsurvey.flinders.edu.au/api/',
      redcapApiToken: 'YOUR_REDCAP_API_TOKEN',
      forwarded: false
    })
  );
}
```

**Case B — a researcher's own Gmail, forwarded in without sharing account access.** See
"Registering a forwarded study" below — same `registerStudy_()` function, `forwarded: true`,
plus one extra one-time setup step.

In REDCap, confirm the study's project has:
- A token field (default name `patient_token`, override via `accessTokenField` in the JSON
  above) — a unique access token issued to each participant. This is their only credential, so
  make it a real random string (12+ characters), not something guessable.
- A forwarding-status field (default `forwarding_status`, override via `forwardingStatusField`)
  — set to `1` once a participant's device alias is active. Login is rejected while it isn't.
- A device email field (default `device_email`, override via `deviceEmailField`) — must exist
  even if usually left blank. When a record has a value here, the backend searches that exact
  address instead of deriving the `base+recordId@gmail.com` alias.

**Checking a study is set up correctly:** the frontend's "Check system status" link (on the
sign-in screen) calls a `healthCheck` action — no token needed — confirming the study's config
resolves, REDCap is reachable with all configured field names actually existing there, and
(depending on mode) either Gmail access or the relay alias works. Run it after every change
instead of debugging through a participant-facing error.

**Removing a study:** run `unregisterStudy_()` with the right `base`, and remove its
`studies.json` entry.

## 3. Add the study to studies.json

[studies.json](studies.json) is a plain public map of `base` → Apps Script URL + display name —
and *only* that. It is never a place for REDCap credentials or anything else secret; those live
exclusively in the backend's Script Properties, set in step 2, never committed to git:

```json
{
  "samma.study": {
    "name": "SAMMA Study",
    "appsScriptUrl": "https://script.google.com/macros/s/.../exec"
  }
}
```

Add an entry keyed by the exact `base` value you registered, pointing at the `/exec` URL from
step 1. Give participants the link `https://<you>.github.io/studylink-portal/?base=<base>`.

## 4. Host the frontend on GitHub Pages

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

## Running multiple studies

A single Pages deployment + single Apps Script deployment can serve any number of studies —
nothing in `index.html` is study-specific, and one Apps Script project can hold any number of
`STUDY_<BASE>` registrations, mixing Case A and Case B freely. To add another:

1. Register it (step 2) — a new `STUDY_<BASE>` property on either an existing deployment or a
   fresh one.
2. Add its entry to `studies.json` (step 3) and push.
3. Send participants `.../?base=<base>`.

`studies.json` being one shared, public file means a mistake in it (wrong URL) can affect any
study listed there, and anyone who finds this repo can see the full list of studies it's
serving (URLs and names only — never credentials). If your institution's review process wants
studies fully compartmentalized instead — separate repos, separate Pages sites, no shared
registry — fork this repo per study and hardcode `APPS_SCRIPT_URL`/`STUDY_NAME` directly in
`index.html` instead of using `studies.json`.

## Registering a forwarded study (Case B): hosting a study whose Gmail you don't control

Sometimes you can't (or a colleague running their own study doesn't want to) create an Apps
Script project inside that study's own Gmail account. **This is solved with Gmail's own mail
forwarding, not account delegation or OAuth** — the researcher keeps their own Gmail exactly
as-is and never shares access; they just forward matching mail to an address on your deployment
("the hub"). Revoking access later is deleting one filter on their end — no token to manage.

0. **One-time, per hub deployment (not per study):** run `setGmailUsername_()` in `Code.gs`
   with this deployment's own Gmail username filled in (the part before `@gmail.com`). Every
   forwarded study's relay alias is derived from this — set it once, no matter how many
   forwarded studies the hub ends up serving. Not needed if this deployment only ever hosts
   Case A studies.
1. Pick a short `base` for the new study (this is the same value that goes in `studies.json`
   and the participant link). The relay alias they'll forward into is always
   `<hub username>+<base>@gmail.com` — e.g. if the hub is `yourhub@gmail.com` and `base` is
   `otherstudy`, the address is `yourhub+otherstudy@gmail.com`. One formula, no separate value
   to agree on or get wrong.
2. The researcher adds that address as a **forwarding address** in their own Gmail (Settings →
   Forwarding and POP/IMAP → Add a forwarding address), confirming a one-time verification
   email sent to the hub.
3. They create a **filter** in their own Gmail matching their device-verification pattern (e.g.
   `to:(theirprefix+*)`) with the action "Forward it to" that same address. They can delete the
   filter at any time to stop it.
4. On the hub, run `registerStudy_()` with `base` set to the value from step 1,
   `forwarded: true`, and `baseEmail` set to the researcher's own Gmail address:
   ```js
   function registerStudy_() {
     const base = 'otherstudy';
     PropertiesService.getScriptProperties().setProperty(
       'STUDY_' + base.toUpperCase(),
       JSON.stringify({
         redcapApiUrl: 'https://their-redcap-instance.org/api/',
         redcapApiToken: 'THEIR_REDCAP_API_TOKEN',
         forwarded: true,
         baseEmail: 'their-study-inbox@gmail.com'
       })
     );
   }
   ```
   This logs the relay alias to the console — double-check it matches what you gave the
   researcher in step 2.
5. Add its `studies.json` entry (step 3 above), pointing `appsScriptUrl` at the **hub's**
   `/exec` URL — the same URL as any other study already hosted there.
6. Give them the link `.../?base=<base>`.

**How the hub tells participants apart.** The relay alias only narrows a search down to "mail
for this study" — many participants share it. Gmail's *automatic* forwarding (via Settings or a
Filter's "Forward it to" action) is a true SMTP relay: it preserves the original message's
`To:` header rather than rewriting it, unlike a human manually clicking "Forward" in the Gmail
UI (which wraps everything in a new message and loses the original headers). The backend reads
that preserved header to work out which participant's original alias
(`theirprefix+recordId@theirgmail.com`, computed from `baseEmail`) a forwarded message actually
belongs to. **Worth confirming this empirically with a real test send** before relying on it —
send a test verification email through the researcher's filter and check it via "Check system
status," since exact header-preservation behavior isn't something Google documents in detail
and could have edge cases.

## Migrating an existing dedicated deployment to this scheme

If you set up a study before this Script Properties layout existed (flat `REDCAP_API_URL` /
`REDCAP_API_TOKEN` / `BASE_EMAIL` properties, no `base` concept), migrate it:

1. Note its current `REDCAP_API_URL` and `REDCAP_API_TOKEN` values (Project Settings → Script
   Properties in the old deployment).
2. Paste the current `backend/Code.gs` into that same Apps Script project, save.
3. Run `registerStudy_()` with `base` set to that account's own Gmail username (the part before
   `@gmail.com`) and the REDCap URL/token from step 1, `forwarded: false`.
4. Delete the old flat `REDCAP_API_URL`, `REDCAP_API_TOKEN`, `BASE_EMAIL` (and any
   `ACCESS_TOKEN_FIELD`/`FORWARDING_STATUS_FIELD`/`DEVICE_EMAIL_FIELD` overrides) Script
   Properties — no longer read by the new code, safe to remove. Leaving them is also harmless;
   they're just unused.
5. Deploy → Manage deployments → pencil icon → New version → Deploy (same `/exec` URL).
6. Update that study's `studies.json` entry's key to the new `base` value if it differs from
   the old one, and update participant links to match (`?base=<new base>` instead of whatever
   arbitrary slug was used before).
7. Confirm via "Check system status" before telling participants.

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
- Every study's REDCap credentials live only in that deployment's Script Properties (server-side,
  per-project) — never in the source file, never sent to the browser, never in `studies.json`,
  never committed to git. Multiple studies' credentials on one hub deployment share that
  project's property store, but remain fully independent JSON blobs from each other.
- Gmail scopes granted to the script (read + modify, to mark messages read) are broad by
  necessity — a Case A deployment's account should be a dedicated study inbox, not a personal one.
- `fetchCode` returns up to the 10 most recent matching emails (not just unread ones) within
  the last day, so a participant can see prior codes if more than one arrived — the frontend
  shows the newest prominently and the rest behind an auto-expand/collapse toggle. This means
  a verified session can see everything sent to that device's address in the last day, not
  just a single one-time code.
- The Gmail search covers `in:anywhere` (including Spam and Trash), not just Inbox — third-party
  device-vendor mail is exactly the kind of thing Gmail sometimes misfires on, and a code
  silently landing in Spam would otherwise look like total failure with nothing to debug.
- `healthCheck` is a public, unauthenticated action (anyone with the deployment URL and a valid
  `base` can call it) by design, so it deliberately returns only pass/fail booleans and short
  diagnostic strings — never the actual REDCap token, URL, or other secret values.
- **Forwarded (Case B) studies concentrate trust in the hub's Gmail owner.** Their verification
  emails land in the hub's own inbox (that's how forwarding works), so whoever controls that
  Google account can technically read every forwarded study's mail, same as they already could
  for their own Case A study. This is the tradeoff of not requiring account handover — the
  researcher never shares their own Gmail, but they are trusting the hub operator with copies
  of their participants' verification mail. Make sure that's acceptable for your institution's
  data-handling requirements before offering this to other researchers.
