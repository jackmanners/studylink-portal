/**
 * StudyLink Portal — Google Apps Script backend
 *
 * Deploy as a Web App (Execute as: Me, Access: Anyone) and paste the
 * resulting /exec URL into index.html (APPS_SCRIPT_URL).
 *
 * Requests are sent by the frontend as POST with Content-Type: text/plain
 * (not application/json) specifically to avoid a CORS preflight — Apps
 * Script Web Apps cannot answer an OPTIONS preflight, so a "simple
 * request" is required. The body is still JSON; it's just labeled as
 * text/plain so the browser doesn't preflight it. Do not change the
 * frontend's fetch() Content-Type without updating this comment/logic.
 *
 * Participants authenticate with a single access token (REDCap field
 * `patient_token`) — there is no separate Participant ID input. The token
 * is looked up in REDCap via filterLogic to find the matching record.
 *
 * ── One config mechanism for every study ─────────────────────────────
 *
 * Every study this deployment serves — whether its Gmail account IS this
 * script's own account, or its mail is forwarded in from somewhere else
 * — is a single `STUDY_<BASE>` Script Property holding one JSON blob
 * (see registerStudy_() below). `base` is always the same value the
 * frontend sends as `?base=` and the same value used as the Gmail
 * plus-addressing prefix for that study's participant aliases
 * (base+recordId@gmail.com) — assumed gmail.com for now.
 *
 * A study is one of two kinds, set via `forwarded` in its config:
 *
 * - forwarded: false (default) — this script's OWN Gmail account is the
 *   study's inbox, and `base` IS that account's username. E.g. if this
 *   script runs under samma.study@gmail.com, register it with
 *   base = "samma.study" and nothing else Gmail-related to configure —
 *   participant aliases are searched directly on this account.
 *
 * - forwarded: true — mail arrives here via another researcher's own
 *   Gmail forwarding filter, without that researcher ever sharing
 *   account access. Requires `baseEmail` (their own Gmail address, used
 *   only to compute what a participant's original alias looks like) and
 *   the GMAIL_USERNAME Script Property (this script's own account's
 *   username) to be set. The relay alias participants' mail actually
 *   forwards to is always derived as GMAIL_USERNAME+base@gmail.com — one
 *   formula, never specified separately. The original per-participant
 *   address is recovered from the forwarded copy's preserved To: header
 *   (Gmail's automatic forwarding is a true SMTP relay and doesn't
 *   rewrite it), since the relay alias alone only narrows a search down
 *   to "this study," not "this participant."
 *
 * A single deployment can host any mix of both kinds simultaneously.
 *
 * Secrets are NOT stored in this file. They live in Script Properties,
 * which are per-project, not part of the source, and never committed to
 * git — see README.md for full setup steps.
 */

// ── Configuration ──────────────────────────────────────────────────────

const OPTIONAL_STUDY_FIELD_DEFAULTS = {
  ACCESS_TOKEN_FIELD: 'patient_token',
  // REDCap field holding a full override email address for a participant's
  // device, if their study collects one directly instead of relying on the
  // record_id-derived "+alias" scheme. Must exist in REDCap (any name is
  // fine via this property) — every study needs *some* field here, even
  // if it's usually left blank per record.
  DEVICE_EMAIL_FIELD: 'device_email',
  // REDCap field whose value must equal '1' for a participant to be
  // considered active for forwarding. Must exist in REDCap.
  FORWARDING_STATUS_FIELD: 'forwarding_status'
};

// How many threads to pull back on an initial Gmail search. Forwarded
// mode searches a whole study's shared relay alias (many participants),
// so it needs a wider net than dedicated mode's per-participant search
// before filtering down to the right one.
const DEDICATED_SEARCH_LIMIT = 10;
const FORWARDED_SEARCH_LIMIT = 50;

function getConfig_(base) {
  if (!base) {
    throw new Error('Missing study identifier.');
  }

  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('STUDY_' + base.toUpperCase());
  if (!raw) {
    throw new Error('Unknown study "' + base + '". Has it been registered with registerStudy_()?');
  }

  let study;
  try {
    study = JSON.parse(raw);
  } catch (err) {
    throw new Error('Malformed STUDY_' + base.toUpperCase() + ' config (invalid JSON).');
  }

  const missing = ['redcapApiUrl', 'redcapApiToken'].filter((key) => !study[key]);
  if (missing.length > 0) {
    throw new Error('Study "' + base + '" config missing: ' + missing.join(', '));
  }

  const forwarded = !!study.forwarded;
  let baseEmail;
  let relayAlias; // only meaningful when forwarded

  if (forwarded) {
    if (!study.baseEmail) {
      throw new Error('Study "' + base + '" has forwarded: true but is missing baseEmail (the researcher\'s own Gmail address).');
    }
    const gmailUsername = props.getProperty('GMAIL_USERNAME');
    if (!gmailUsername) {
      throw new Error('Missing Script Property: GMAIL_USERNAME (required for any forwarded study).');
    }
    baseEmail = study.baseEmail;
    relayAlias = gmailUsername + '+' + base + '@gmail.com';
  } else {
    // Not forwarded: this script's own account IS the study's inbox, and
    // `base` IS that account's Gmail username — nothing else to store.
    baseEmail = base + '@gmail.com';
  }

  return {
    REDCAP_API_URL: study.redcapApiUrl,
    REDCAP_API_TOKEN: study.redcapApiToken,
    BASE_EMAIL: baseEmail,
    RELAY_ALIAS: relayAlias,
    FORWARDED: forwarded,
    ACCESS_TOKEN_FIELD: study.accessTokenField || OPTIONAL_STUDY_FIELD_DEFAULTS.ACCESS_TOKEN_FIELD,
    FORWARDING_STATUS_FIELD: study.forwardingStatusField || OPTIONAL_STUDY_FIELD_DEFAULTS.FORWARDING_STATUS_FIELD,
    DEVICE_EMAIL_FIELD: study.deviceEmailField || OPTIONAL_STUDY_FIELD_DEFAULTS.DEVICE_EMAIL_FIELD
  };
}

// Only required if this deployment will host any forwarded study — not
// needed for a deployment that only ever serves its own dedicated
// study/studies. This script's own Gmail username (before @gmail.com).
function setGmailUsername_() {
  PropertiesService.getScriptProperties().setProperty('GMAIL_USERNAME', 'yourhub');
}

// The one way to register any study, dedicated or forwarded. Fill in
// real values, select this function from the dropdown, click Run once.
//
// Dedicated study (this script's own Gmail account is the inbox): set
// `base` to exactly match this account's own Gmail username, leave
// `forwarded: false`, and omit `baseEmail` entirely.
//
// Forwarded study (mail relayed in from another researcher's own
// Gmail, who never shares account access): set `forwarded: true` and
// `baseEmail` to their Gmail address; `base` can be any short routing
// key you choose. Requires GMAIL_USERNAME to already be set
// (setGmailUsername_()) — the relay alias they need to forward into is
// logged after running this.
function registerStudy_() {
  const base = 'BASE_HERE';
  PropertiesService.getScriptProperties().setProperty(
    'STUDY_' + base.toUpperCase(),
    JSON.stringify({
      base: base,                                  // preserves original casing for admin.html's listing
      redcapApiUrl: 'https://their-redcap-instance.org/api/',
      redcapApiToken: 'THEIR_REDCAP_API_TOKEN',
      forwarded: false,
      // baseEmail: 'their-study-inbox@gmail.com', // required only if forwarded: true
      accessTokenField: 'patient_token',           // optional, shown are the defaults
      forwardingStatusField: 'forwarding_status',
      deviceEmailField: 'device_email'
    })
  );

  const gmailUsername = PropertiesService.getScriptProperties().getProperty('GMAIL_USERNAME');
  if (gmailUsername) {
    Logger.log('If forwarded, relay alias for this study: ' + gmailUsername + '+' + base + '@gmail.com');
  }
}

// Removes a study's registration. Run manually with the right base.
function unregisterStudy_() {
  const base = 'BASE_HERE';
  PropertiesService.getScriptProperties().deleteProperty('STUDY_' + base.toUpperCase());
}

// Required once per deployment to use the admin panel (admin.html) —
// without this set, all admin* actions are refused. Treat this value
// like a master password: anyone who has it can register, edit, or
// remove any study on this deployment, including setting arbitrary
// REDCap credentials. Pick something long and random, store it in a
// password manager, never commit it anywhere.
function setAdminToken_() {
  PropertiesService.getScriptProperties().setProperty('ADMIN_TOKEN', 'CHOOSE_A_LONG_RANDOM_TOKEN');
}

// Failed-verify lockout: max attempts per token within LOCKOUT_WINDOW_SEC.
const MAX_VERIFY_ATTEMPTS = 5;
const LOCKOUT_WINDOW_SEC = 600; // 10 minutes

// How long a verified token stays authorized to call fetchCode without
// re-checking REDCap. Comfortably covers the frontend's 2-minute poll.
const SESSION_TTL_SEC = 300; // 5 minutes

// ── Entry point ─────────────────────────────────────────────────────────

const ADMIN_ACTIONS = ['adminListStudies', 'adminRegisterStudy', 'adminUnregisterStudy'];

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOutput({ success: false, error: 'Invalid request body.' });
  }

  const action = body.action;

  if (ADMIN_ACTIONS.indexOf(action) !== -1) {
    const authError = checkAdminToken_(body.adminToken);
    if (authError) {
      return jsonOutput({ success: false, error: authError });
    }
    try {
      if (action === 'adminListStudies') {
        return jsonOutput(handleAdminListStudies());
      }
      if (action === 'adminRegisterStudy') {
        return jsonOutput(handleAdminRegisterStudy(body.study));
      }
      if (action === 'adminUnregisterStudy') {
        return jsonOutput(handleAdminUnregisterStudy(body.base));
      }
    } catch (err) {
      return jsonOutput({ success: false, error: 'Server error: ' + err.message });
    }
  }

  const base = sanitizeBase_(body.base);
  if (!base) {
    return jsonOutput({ success: false, error: 'Missing or invalid study identifier.' });
  }

  // healthCheck is a config/connectivity diagnostic, not a participant
  // action — it doesn't take or need a token.
  if (action === 'healthCheck') {
    return jsonOutput(handleHealthCheck(base));
  }

  const token = sanitizeToken(body.token);
  if (!token) {
    return jsonOutput({ success: false, error: 'Please enter your access token.' });
  }

  try {
    if (action === 'verify') {
      return jsonOutput(handleVerify(token, base));
    }
    if (action === 'fetchCode') {
      return jsonOutput(handleFetchCode(token, base));
    }
    return jsonOutput({ success: false, error: 'Unknown action.' });
  } catch (err) {
    return jsonOutput({ success: false, error: 'Server error: ' + err.message });
  }
}

// ── Action: healthCheck ─────────────────────────────────────────────────
// Public diagnostic — deliberately returns only pass/fail + short
// messages, never actual secret values (REDCap token/URL, etc.), since
// this endpoint takes no token and anyone with the deployment URL can
// call it.

function handleHealthCheck(base) {
  const checks = [];
  let config;

  try {
    config = getConfig_(base);
    checks.push({ label: 'Config resolved (' + (config.FORWARDED ? 'forwarded' : 'dedicated') + ')', ok: true });
  } catch (err) {
    checks.push({ label: 'Config resolved', ok: false, detail: err.message });
    return { checks: checks, ok: false };
  }

  checks.push(checkRedcap_(config));
  checks.push(config.FORWARDED ? checkRelay_(config) : checkGmail_());

  return { checks: checks, ok: checks.every((c) => c.ok) };
}

// REDCap validates requested field names against the project's data
// dictionary even when the filter matches zero records, so a single
// export call against a filter that can never match confirms both
// connectivity and that all four configured field names actually exist.
function checkRedcap_(config) {
  const fields = ['record_id', config.ACCESS_TOKEN_FIELD, config.FORWARDING_STATUS_FIELD, config.DEVICE_EMAIL_FIELD];
  const payload = {
    token: config.REDCAP_API_TOKEN,
    content: 'record',
    format: 'json',
    type: 'flat',
    filterLogic: "[record_id]='__studylink_healthcheck_no_such_record__'",
    returnFormat: 'json'
  };
  fields.forEach((f, i) => { payload['fields[' + i + ']'] = f; });

  let response;
  try {
    response = UrlFetchApp.fetch(config.REDCAP_API_URL, {
      method: 'post',
      payload: payload,
      muteHttpExceptions: true
    });
  } catch (err) {
    return { label: 'REDCap reachable, fields exist', ok: false, detail: 'Request failed: ' + err.message };
  }

  if (response.getResponseCode() === 200) {
    return { label: 'REDCap reachable, fields exist (' + fields.join(', ') + ')', ok: true };
  }
  return {
    label: 'REDCap reachable, fields exist',
    ok: false,
    detail: 'HTTP ' + response.getResponseCode() + ': ' + response.getContentText().substring(0, 200)
  };
}

function checkGmail_() {
  try {
    GmailApp.search('in:inbox', 0, 1);
    return { label: 'Gmail access working', ok: true };
  } catch (err) {
    return { label: 'Gmail access working', ok: false, detail: err.message };
  }
}

function checkRelay_(config) {
  try {
    const threads = GmailApp.search('to:' + config.RELAY_ALIAS + ' in:anywhere', 0, 1);
    return {
      label: 'Relay alias reachable (' + config.RELAY_ALIAS + ')',
      ok: true,
      detail: threads.length === 0 ? 'No mail seen yet at this alias — expected until the researcher sends a real test.' : undefined
    };
  } catch (err) {
    return { label: 'Relay alias reachable', ok: false, detail: err.message };
  }
}

// ── Admin actions (admin.html) ────────────────────────────────────────
// Lets studies be registered/edited/removed from the browser instead of
// the Apps Script editor. Gated by ADMIN_TOKEN (see setAdminToken_()) —
// these responses never echo back REDCap credentials once stored, only
// booleans/labels, so a stolen adminListStudies response can't leak them.

const MAX_ADMIN_ATTEMPTS = 5;
const ADMIN_LOCKOUT_WINDOW_SEC = 600; // 10 minutes

function checkAdminToken_(token) {
  const cache = CacheService.getScriptCache();
  const attemptsKey = 'admin_attempts';
  const attempts = Number(cache.get(attemptsKey) || 0);
  if (attempts >= MAX_ADMIN_ATTEMPTS) {
    return 'Too many attempts. Please try again later.';
  }

  const expected = PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN');
  if (!expected) {
    return 'Admin token not configured on this deployment. Run setAdminToken_() first.';
  }
  if (String(token || '') !== expected) {
    cache.put(attemptsKey, String(attempts + 1), ADMIN_LOCKOUT_WINDOW_SEC);
    return 'Invalid admin token.';
  }

  cache.remove(attemptsKey);
  return null; // authorized
}

function handleAdminListStudies() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const studies = Object.keys(props)
    .filter((key) => key.indexOf('STUDY_') === 0)
    .map((key) => {
      let parsed = {};
      try {
        parsed = JSON.parse(props[key]);
      } catch (err) {
        // Malformed entry — still list it (by its property-key casing)
        // so the admin can see and fix or remove it.
      }
      return {
        base: parsed.base || key.substring('STUDY_'.length),
        forwarded: !!parsed.forwarded,
        hasRedcapUrl: !!parsed.redcapApiUrl,
        hasRedcapToken: !!parsed.redcapApiToken,
        baseEmail: parsed.forwarded ? (parsed.baseEmail || '') : ''
      };
    })
    .sort((a, b) => a.base.localeCompare(b.base));

  return { success: true, studies: studies };
}

// Creates or updates a study. Any of redcapApiUrl/redcapApiToken/
// baseEmail/accessTokenField/forwardingStatusField/deviceEmailField left
// blank when editing an existing study keeps that study's current value
// — this endpoint never has to round-trip secrets back to the browser
// just so an edit can preserve them.
function handleAdminRegisterStudy(study) {
  if (!study || typeof study !== 'object') {
    return { success: false, error: 'Missing study data.' };
  }

  const base = sanitizeBase_(study.base);
  if (!base) {
    return { success: false, error: 'Invalid or missing base value.' };
  }

  const props = PropertiesService.getScriptProperties();
  const propKey = 'STUDY_' + base.toUpperCase();

  let existing = {};
  const existingRaw = props.getProperty(propKey);
  if (existingRaw) {
    try { existing = JSON.parse(existingRaw); } catch (err) { existing = {}; }
  }

  const config = {
    base: base,
    redcapApiUrl: String(study.redcapApiUrl || existing.redcapApiUrl || '').trim(),
    redcapApiToken: String(study.redcapApiToken || existing.redcapApiToken || '').trim(),
    forwarded: study.forwarded !== undefined ? !!study.forwarded : !!existing.forwarded
  };

  if (!config.redcapApiUrl || !config.redcapApiToken) {
    return { success: false, error: 'REDCap URL and token are required (existing values are kept if left blank while editing).' };
  }

  if (config.forwarded) {
    config.baseEmail = String(study.baseEmail || existing.baseEmail || '').trim();
    if (!config.baseEmail) {
      return { success: false, error: 'baseEmail is required when forwarded is true.' };
    }
  }

  ['accessTokenField', 'forwardingStatusField', 'deviceEmailField'].forEach((key) => {
    const value = String(study[key] || existing[key] || '').trim();
    if (value) config[key] = value;
  });

  props.setProperty(propKey, JSON.stringify(config));

  let relayAlias = null;
  if (config.forwarded) {
    const gmailUsername = props.getProperty('GMAIL_USERNAME');
    if (gmailUsername) {
      relayAlias = gmailUsername + '+' + base + '@gmail.com';
    }
  }

  return { success: true, base: base, forwarded: config.forwarded, relayAlias: relayAlias };
}

function handleAdminUnregisterStudy(base) {
  const clean = sanitizeBase_(base);
  if (!clean) {
    return { success: false, error: 'Invalid base value.' };
  }
  PropertiesService.getScriptProperties().deleteProperty('STUDY_' + clean.toUpperCase());
  return { success: true };
}

// ── Action: verify ─────────────────────────────────────────────────────

function handleVerify(token, base) {
  if (isLockedOut(token)) {
    return { success: false, error: 'Too many attempts. Please try again later.' };
  }

  const config = getConfig_(base);
  const record = findRecordByToken(token, config);

  if (!record) {
    registerFailedAttempt(token);
    return { success: false, error: 'That access token wasn\'t recognized. Please check it and try again.' };
  }

  if (record.forwarding_status !== '1') {
    registerFailedAttempt(token);
    return { success: false, error: 'Your device isn\'t set up yet. Please contact your study coordinator.' };
  }

  clearFailedAttempts(token);
  const deviceEmail = String(record.device_email || '').trim();
  const address = deviceEmail || buildAlias(record.record_id, config);
  startSession(token, record.record_id, deviceEmail);

  return { success: true, recordId: record.record_id, address: address };
}

// ── Action: fetchCode ──────────────────────────────────────────────────

// Cap on how many matched emails we'll ever return, oldest dropped first.
const MAX_MATCHES_RETURNED = 10;

function handleFetchCode(token, base) {
  const session = getSession(token);
  if (!session) {
    return { found: false, error: 'Session expired. Please sign in again.' };
  }

  const config = getConfig_(base);
  const expectedAddress = (session.deviceEmail || buildAlias(session.recordId, config)).toLowerCase();

  // Not restricted to is:unread — we want every matching email in the
  // window, not just ones not yet marked read. in:anywhere includes Spam
  // and Trash — third-party device-vendor mail is exactly the kind of
  // thing Gmail sometimes misfires on, and a code silently landing in
  // Spam would otherwise look like total failure with nothing to debug.
  let threads;
  if (config.FORWARDED) {
    // The relay alias only narrows to "this study" (many participants
    // share it) — filtered down to "this participant" below.
    threads = GmailApp.search('to:' + config.RELAY_ALIAS + ' newer_than:1d in:anywhere', 0, FORWARDED_SEARCH_LIMIT);
  } else {
    threads = GmailApp.search('to:' + expectedAddress + ' newer_than:1d in:anywhere', 0, DEDICATED_SEARCH_LIMIT);
  }
  if (threads.length === 0) {
    return { found: false };
  }

  let allMessages = [];
  threads.forEach((thread) => {
    allMessages = allMessages.concat(thread.getMessages());
  });

  if (config.FORWARDED) {
    // Gmail's automatic forwarding (Settings/Filters "Forward it to") is
    // a true SMTP relay — it preserves the original message's To: header
    // rather than rewriting it to the relay address. That preserved
    // header is how we recover which participant a forwarded message
    // actually belongs to.
    allMessages = allMessages.filter((message) => {
      const to = (message.getTo() || '').toLowerCase();
      return to.indexOf(expectedAddress) !== -1;
    });
    if (allMessages.length === 0) {
      return { found: false };
    }
  }

  allMessages.sort((a, b) => b.getDate().getTime() - a.getDate().getTime());

  const matches = [];
  for (let i = 0; i < allMessages.length && matches.length < MAX_MATCHES_RETURNED; i++) {
    const message = allMessages[i];
    const subject = message.getSubject();
    const code = extractCode(message.getPlainBody()) || extractCode(subject);
    if (!code) continue;
    matches.push({ code: code, subject: subject, receivedAt: message.getDate().toISOString() });
  }

  if (matches.length === 0) {
    return { found: false };
  }

  // Mark the newest message read once, as a best-effort "seen" marker —
  // harmless if it was already read, and no longer needed for the search
  // to keep working since we no longer filter on is:unread.
  if (allMessages[0].isUnread()) {
    allMessages[0].markRead();
  }

  const primary = matches[0];
  return {
    found: true,
    code: primary.code,
    subject: primary.subject,
    receivedAt: primary.receivedAt,
    messages: matches
  };
}

// ── REDCap lookup ─────────────────────────────────────────────────────────

function findRecordByToken(token, config) {
  const payload = {
    token: config.REDCAP_API_TOKEN,
    content: 'record',
    format: 'json',
    type: 'flat',
    filterLogic: '[' + config.ACCESS_TOKEN_FIELD + ']=\'' + token.replace(/'/g, "\\'") + '\'',
    'fields[0]': 'record_id',
    'fields[1]': config.FORWARDING_STATUS_FIELD,
    'fields[2]': config.DEVICE_EMAIL_FIELD,
    returnFormat: 'json'
  };

  const response = UrlFetchApp.fetch(config.REDCAP_API_URL, {
    method: 'post',
    payload: payload,
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error(
      'REDCap request failed (HTTP ' + response.getResponseCode() + '): ' +
      response.getContentText().substring(0, 300)
    );
  }

  let records;
  try {
    records = JSON.parse(response.getContentText());
  } catch (err) {
    throw new Error('Unexpected REDCap response.');
  }

  if (!Array.isArray(records) || records.length !== 1) {
    return null;
  }

  const raw = records[0];
  return {
    record_id: raw.record_id,
    forwarding_status: raw[config.FORWARDING_STATUS_FIELD],
    device_email: raw[config.DEVICE_EMAIL_FIELD]
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function buildAlias(recordId, config) {
  const baseEmail = config.BASE_EMAIL;
  const at = baseEmail.indexOf('@');
  const local = baseEmail.substring(0, at);
  const domain = baseEmail.substring(at + 1);
  return local + '+' + recordId + '@' + domain;
}

function extractCode(text) {
  if (!text) return null;
  const match = text.match(/\b\d{4,8}\b/);
  return match ? match[0] : null;
}

function sanitizeToken(token) {
  const str = String(token || '').trim();
  return /^[A-Za-z0-9_-]{4,64}$/.test(str) ? str : null;
}

// Allows dots — real Gmail addresses commonly contain them (e.g. a
// dedicated study's own username is often "study.name"-shaped).
function sanitizeBase_(base) {
  const str = String(base || '').trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(str) ? str : '';
}

function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Session (per token, using CacheService) ──────────────────────────────
// Avoids re-querying REDCap on every 5-second poll during fetchCode.

function startSession(token, recordId, deviceEmail) {
  const value = JSON.stringify({ recordId: recordId, deviceEmail: deviceEmail || '' });
  CacheService.getScriptCache().put('session_' + token, value, SESSION_TTL_SEC);
}

function getSession(token) {
  const raw = CacheService.getScriptCache().get('session_' + token);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

// ── Lockout (per token, using CacheService) ──────────────────────────────

function isLockedOut(token) {
  const cache = CacheService.getScriptCache();
  const count = Number(cache.get('attempts_' + token) || 0);
  return count >= MAX_VERIFY_ATTEMPTS;
}

function registerFailedAttempt(token) {
  const cache = CacheService.getScriptCache();
  const key = 'attempts_' + token;
  const count = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(count), LOCKOUT_WINDOW_SEC);
}

function clearFailedAttempts(token) {
  CacheService.getScriptCache().remove('attempts_' + token);
}
