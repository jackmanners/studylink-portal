# StudyLink Portal

Static frontend (GitHub Pages) + Google Apps Script backend (Gmail + REDCap). Participants log
in with a token and get their device's verification code.

- `index.html` — participant login/code page
- `admin.html` — study management UI
- `backend/Code.gs` — Apps Script Web App
- `studies.json` — public map of `base` → Apps Script URL + name. **Never contains secrets.**

## Deploy the backend

1. [script.google.com](https://script.google.com) → new project, under the Gmail account that
   will run this deployment.
2. Paste in `backend/Code.gs`.
3. Deploy → New deployment → Web app → Execute as **Me** → Access **Anyone** → Deploy. Authorize
   the requested scopes.
4. Copy the `/exec` URL.

Redeploy (Manage deployments → pencil → New version) any time the code changes — same URL.

## Register a study

Every study is one `STUDY_<BASE>` Script Property (JSON). `base` is used everywhere: the
`studies.json` key, the `?base=` link param, and — for a study whose Gmail this deployment owns
directly — that account's own username.

**Dedicated** (this deployment's own Gmail is the study's inbox — `base` = that account's
username):

```js
function registerStudy() {
  const base = 'samma.study';
  PropertiesService.getScriptProperties().setProperty('STUDY_' + base.toUpperCase(), JSON.stringify({
    redcapApiUrl: 'https://researchsurvey.flinders.edu.au/api/',
    redcapApiToken: 'YOUR_REDCAP_API_TOKEN',
    forwarded: false
  }));
}
```

**Forwarded** (another researcher's own Gmail, no account access shared) — see below.

Or use [admin.html](admin.html) instead of the editor.

REDCap project needs: a token field (`patient_token` default), a status field
(`forwarding_status` default, must be `1` to allow login), a device-email override field
(`device_email` default, can be blank per record). Override names via `accessTokenField` /
`forwardingStatusField` / `deviceEmailField` in the JSON above.

Remove a study: `unregisterStudy()`. Check a study's config: "Check system status" on the
sign-in page (no token needed).

## Add to studies.json

```json
{
  "samma.study": { "name": "SAMMA Study", "appsScriptUrl": "https://script.google.com/macros/s/.../exec" }
}
```

Participant link: `https://<you>.github.io/studylink-portal/?base=<base>`.

## Host on GitHub Pages

```bash
git remote add origin https://github.com/<you>/studylink-portal.git
git push -u origin main
```

Settings → Pages → Deploy from branch → `main` / root.

## Forwarded studies (no Gmail access needed)

Lets a researcher's own Gmail forward matching mail to your deployment ("the hub") without ever
sharing account access.

1. Once per hub: `setGmailUsername()` with the hub's own Gmail username.
2. Pick a `base`. Relay alias is always `<hub username>+<base>@gmail.com`.
3. Researcher adds that address as a Gmail forwarding address, then a filter forwarding matching
   mail to it. They can delete the filter anytime.
4. `registerStudy()` with `forwarded: true` and `baseEmail` = their Gmail address:

```js
function registerStudy() {
  const base = 'otherstudy';
  PropertiesService.getScriptProperties().setProperty('STUDY_' + base.toUpperCase(), JSON.stringify({
    redcapApiUrl: 'https://their-redcap-instance.org/api/',
    redcapApiToken: 'THEIR_REDCAP_API_TOKEN',
    forwarded: true,
    baseEmail: 'their-study-inbox@gmail.com'
  }));
}
```

5. Add to `studies.json`, pointing at the hub's `/exec` URL.

Gmail's automatic forwarding preserves the original `To:` header (a manual forward doesn't), so
the backend recovers which participant a forwarded message belongs to from that header. Test
with a real send before relying on it for a study.

## Admin panel

`admin.html` does the same register/edit/remove as above, from a form.

Setup: Script Property `ADMIN_TOKEN` (long random value) — set directly, or via
`setAdminToken()`. Treat it like a REDCap credential.

Usage: pick the deployment (dropdown from `studies.json`, or "Other" for a new one), enter the
token, Load studies. It doesn't edit `studies.json` for you — copies a snippet to paste in.

## Security

- Access token is the only credential — issue random 12+ char strings, not guessable ones.
- 5 failed attempts / 10 min lockout, per token (participant and admin tokens separately). No
  IP-based throttling.
- Credentials live only in Script Properties — never in `studies.json`, never in git, never
  sent to the browser.
- `fetchCode` searches `in:anywhere` (incl. Spam/Trash) and returns up to 10 recent matches, not
  just the latest.
- `healthCheck` needs no token but returns only pass/fail, never secrets.
- Forwarded-study mail lands in the hub's own inbox — the hub owner can technically read it,
  same trust level as their own dedicated study, just extended to studies hosted for others.

## Later (uncommitted)

Possible future direction: replace Gmail/Apps Script entirely with Cloudflare Email Routing +
Workers — one real multi-tenant backend, custom domain, no per-study Gmail account needed. A
bigger rebuild, not started.
