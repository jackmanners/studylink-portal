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
 * ── Two deployment modes, same file ──────────────────────────────────
 *
 * 1. Dedicated (default): this script's own Gmail account IS the study's
 *    device-verification inbox. Config is flat Script Properties
 *    (REDCAP_API_URL etc.) — see setup_() below. This is unchanged from
 *    earlier versions and needs no `study` slug to work.
 *
 * 2. Hub (forwarded): this script's Gmail account is a shared *hub* that
 *    OTHER researchers forward their own device-verification mail into,
 *    without ever sharing account access — they add this hub's address
 *    as a Gmail forwarding target in their own inbox and filter matching
 *    mail to it. Each such study is registered here via registerStudy_()
 *    with its own REDCap config, its own relay alias (e.g.
 *    hub+studyslug@gmail.com), and the researcher's own base email (used
 *    only to compute what a participant's original alias looks like).
 *    The frontend sends a `study` slug on every request; if a matching
 *    STUDY_<SLUG> Script Property exists, hub mode is used for that
 *    request — otherwise it falls back to dedicated/flat config,
 *    ignoring the slug. A single deployment can mix both: serve its own
 *    dedicated study AND host any number of forwarded ones.
 *
 * Secrets are NOT stored in this file. They live in Script Properties,
 * which are per-project, not part of the source, and never committed to
 * git. See README.md for full setup steps for both modes.
 */

// ── Configuration ──────────────────────────────────────────────────────

// Required for dedicated/flat mode — no defaults, fails loudly if unset.
const REQUIRED_PROPERTIES = ['REDCAP_API_URL', 'REDCAP_API_TOKEN', 'BASE_EMAIL'];

// Optional in both modes — fall back to these if unset/omitted. Override
// only if a study's REDCap project names these fields differently.
const OPTIONAL_PROPERTY_DEFAULTS = {
  ACCESS_TOKEN_FIELD: 'patient_token',
  // REDCap field holding a full override email address for a participant's
  // device, if their study collects one directly instead of relying on the
  // record_id-derived "+alias" scheme. Must exist in REDCap (any name is
  // fine via this property) — every study using this script needs *some*
  // field here, even if it's usually left blank per record.
  DEVICE_EMAIL_FIELD: 'device_email',
  // REDCap field whose value must equal '1' for a participant to be
  // considered active for forwarding. Must exist in REDCap.
  FORWARDING_STATUS_FIELD: 'forwarding_status'
};

// How many threads to pull back on an initial Gmail search. Hub mode
// searches a whole study's shared relay alias (many participants), so it
// needs a wider net than dedicated mode's per-participant search before
// filtering down to the right one.
const DEDICATED_SEARCH_LIMIT = 10;
const HUB_SEARCH_LIMIT = 50;

function getConfig_(studySlug) {
  const props = PropertiesService.getScriptProperties();

  if (studySlug) {
    const raw = props.getProperty('STUDY_' + studySlug.toUpperCase());
    if (raw) {
      return normalizeHubConfig_(raw, studySlug);
    }
    // No matching hub registration for this slug — fall through to
    // dedicated/flat config below, so a non-hub deployment just ignores
    // an unrecognized slug rather than failing.
  }

  const config = {};
  REQUIRED_PROPERTIES.forEach((key) => { config[key] = props.getProperty(key); });
  const missing = REQUIRED_PROPERTIES.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error('Missing Script Properties: ' + missing.join(', ') + '. See README.md.');
  }

  Object.keys(OPTIONAL_PROPERTY_DEFAULTS).forEach((key) => {
    config[key] = props.getProperty(key) || OPTIONAL_PROPERTY_DEFAULTS[key];
  });

  config.HUB = false;
  return config;
}

function normalizeHubConfig_(rawJson, slug) {
  let raw;
  try {
    raw = JSON.parse(rawJson);
  } catch (err) {
    throw new Error('Malformed STUDY_' + slug.toUpperCase() + ' config (invalid JSON).');
  }

  const required = ['redcapApiUrl', 'redcapApiToken', 'baseEmail', 'relayAlias'];
  const missing = required.filter((key) => !raw[key]);
  if (missing.length > 0) {
    throw new Error('Study "' + slug + '" config missing: ' + missing.join(', '));
  }

  return {
    REDCAP_API_URL: raw.redcapApiUrl,
    REDCAP_API_TOKEN: raw.redcapApiToken,
    BASE_EMAIL: raw.baseEmail,
    ACCESS_TOKEN_FIELD: raw.accessTokenField || OPTIONAL_PROPERTY_DEFAULTS.ACCESS_TOKEN_FIELD,
    FORWARDING_STATUS_FIELD: raw.forwardingStatusField || OPTIONAL_PROPERTY_DEFAULTS.FORWARDING_STATUS_FIELD,
    DEVICE_EMAIL_FIELD: raw.deviceEmailField || OPTIONAL_PROPERTY_DEFAULTS.DEVICE_EMAIL_FIELD,
    RELAY_ALIAS: raw.relayAlias,
    HUB: true
  };
}

// One-time setup helper for DEDICATED mode — run manually from the Apps
// Script editor (select this function, click Run) instead of using the
// Project Settings UI, if you prefer. Fill in real values first, run
// once, then it's safe to leave these lines in place (they only ever
// write to this specific project's Script Properties, never to git).
function setup_() {
  PropertiesService.getScriptProperties().setProperties({
    REDCAP_API_URL: 'https://your-redcap-instance.org/api/',
    REDCAP_API_TOKEN: 'YOUR_REDCAP_API_TOKEN',
    BASE_EMAIL: 'study@gmail.com'
    // ACCESS_TOKEN_FIELD: 'patient_token', // optional — uncomment to override
  });
}

// One-time helper for registering a NEW forwarded (hub) study on this
// deployment. Fill in real values, select this function from the
// dropdown, click Run once. `slug` must exactly match (case-insensitive)
// the `?study=` value the frontend's studies.json entry uses for this
// study. `relayAlias` must be the exact address you gave the researcher
// to forward into — using a distinct alias per study (this hub account's
// own address, plus-addressed, e.g. hub+slug@gmail.com) is what lets one
// hub inbox host many studies without their mail getting mixed up.
function registerStudy_() {
  const slug = 'SLUG_HERE';
  PropertiesService.getScriptProperties().setProperty(
    'STUDY_' + slug.toUpperCase(),
    JSON.stringify({
      redcapApiUrl: 'https://their-redcap-instance.org/api/',
      redcapApiToken: 'THEIR_REDCAP_API_TOKEN',
      baseEmail: 'their-study-inbox@gmail.com', // the researcher's OWN Gmail — used only to derive expected +alias addresses, never searched directly
      relayAlias: 'hub+' + slug + '@gmail.com', // must match what the researcher's Gmail filter forwards to
      accessTokenField: 'patient_token',        // optional, shown are the defaults
      forwardingStatusField: 'forwarding_status',
      deviceEmailField: 'device_email'
    })
  );
}

// Removes a hub study's registration. Run manually with the right slug.
function unregisterStudy_() {
  const slug = 'SLUG_HERE';
  PropertiesService.getScriptProperties().deleteProperty('STUDY_' + slug.toUpperCase());
}

// Failed-verify lockout: max attempts per token within LOCKOUT_WINDOW_SEC.
const MAX_VERIFY_ATTEMPTS = 5;
const LOCKOUT_WINDOW_SEC = 600; // 10 minutes

// How long a verified token stays authorized to call fetchCode without
// re-checking REDCap. Comfortably covers the frontend's 2-minute poll.
const SESSION_TTL_SEC = 300; // 5 minutes

// ── Entry point ─────────────────────────────────────────────────────────

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOutput({ success: false, error: 'Invalid request body.' });
  }

  const action = body.action;
  const studySlug = sanitizeSlug_(body.study);

  // healthCheck is a config/connectivity diagnostic, not a participant
  // action — it doesn't take or need a token.
  if (action === 'healthCheck') {
    return jsonOutput(handleHealthCheck(studySlug));
  }

  const token = sanitizeToken(body.token);
  if (!token) {
    return jsonOutput({ success: false, error: 'Please enter your access token.' });
  }

  try {
    if (action === 'verify') {
      return jsonOutput(handleVerify(token, studySlug));
    }
    if (action === 'fetchCode') {
      return jsonOutput(handleFetchCode(token, studySlug));
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

function handleHealthCheck(studySlug) {
  const checks = [];
  let config;

  try {
    config = getConfig_(studySlug);
    const mode = config.HUB ? 'hub study "' + studySlug + '"' : 'dedicated/default';
    checks.push({ label: 'Config resolved (' + mode + ')', ok: true });
  } catch (err) {
    checks.push({ label: 'Config resolved', ok: false, detail: err.message });
    return { checks: checks, ok: false };
  }

  checks.push(checkRedcap_(config));
  checks.push(config.HUB ? checkRelay_(config) : checkGmail_());

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

// ── Action: verify ─────────────────────────────────────────────────────

function handleVerify(token, studySlug) {
  if (isLockedOut(token)) {
    return { success: false, error: 'Too many attempts. Please try again later.' };
  }

  const config = getConfig_(studySlug);
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

function handleFetchCode(token, studySlug) {
  const session = getSession(token);
  if (!session) {
    return { found: false, error: 'Session expired. Please sign in again.' };
  }

  const config = getConfig_(studySlug);
  const expectedAddress = (session.deviceEmail || buildAlias(session.recordId, config)).toLowerCase();

  // Not restricted to is:unread — we want every matching email in the
  // window, not just ones not yet marked read. in:anywhere includes Spam
  // and Trash — third-party device-vendor mail is exactly the kind of
  // thing Gmail sometimes misfires on, and a code silently landing in
  // Spam would otherwise look like total failure with nothing to debug.
  let threads;
  if (config.HUB) {
    // Hub mode: the relay alias only narrows to "this study" (many
    // participants share it) — filtered down to "this participant" below.
    threads = GmailApp.search('to:' + config.RELAY_ALIAS + ' newer_than:1d in:anywhere', 0, HUB_SEARCH_LIMIT);
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

  if (config.HUB) {
    // Gmail's automatic forwarding (Settings/Filters "Forward it to") is
    // a true SMTP relay — it preserves the original message's To: header
    // rather than rewriting it to the hub's own relay address. That
    // preserved header is how we recover which participant a forwarded
    // message actually belongs to.
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

function sanitizeSlug_(slug) {
  const str = String(slug || '').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(str) ? str : '';
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
