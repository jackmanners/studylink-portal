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
 * Secrets (REDCAP_API_URL, REDCAP_API_TOKEN, BASE_EMAIL) are NOT stored in
 * this file. They live in Script Properties, which are per-project, not
 * part of the source, and never committed to git. Set them once via
 * Project Settings → Script Properties in the Apps Script editor, or by
 * running setup_() below with your own values filled in. See README.md.
 */

// ── Configuration ──────────────────────────────────────────────────────

// Required Script Properties — no defaults, deployment fails loudly if unset.
const REQUIRED_PROPERTIES = ['REDCAP_API_URL', 'REDCAP_API_TOKEN', 'BASE_EMAIL'];

// Optional Script Properties — fall back to these if unset. Override only
// if a given study's REDCap project names the token field differently.
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

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const config = {};

  REQUIRED_PROPERTIES.forEach((key) => { config[key] = props.getProperty(key); });
  const missing = REQUIRED_PROPERTIES.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error('Missing Script Properties: ' + missing.join(', ') + '. See README.md.');
  }

  Object.keys(OPTIONAL_PROPERTY_DEFAULTS).forEach((key) => {
    config[key] = props.getProperty(key) || OPTIONAL_PROPERTY_DEFAULTS[key];
  });

  return config;
}

// One-time setup helper — run manually from the Apps Script editor
// (select this function, click Run) instead of using the Project
// Settings UI, if you prefer. Fill in real values first, run once per
// study/deployment, then it's safe to leave these lines in place (they
// only ever write to this specific project's Script Properties, never to
// git — each study gets its own Apps Script project and its own copy of
// this file, so there's nothing to leak between studies).
function setup_() {
  PropertiesService.getScriptProperties().setProperties({
    REDCAP_API_URL: 'https://your-redcap-instance.org/api/',
    REDCAP_API_TOKEN: 'YOUR_REDCAP_API_TOKEN',
    BASE_EMAIL: 'study@gmail.com'
    // ACCESS_TOKEN_FIELD: 'patient_token', // optional — uncomment to override
  });
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
  const token = sanitizeToken(body.token);

  if (!token) {
    return jsonOutput({ success: false, error: 'Missing or invalid access token.' });
  }

  try {
    if (action === 'verify') {
      return jsonOutput(handleVerify(token));
    }
    if (action === 'fetchCode') {
      return jsonOutput(handleFetchCode(token));
    }
    return jsonOutput({ success: false, error: 'Unknown action.' });
  } catch (err) {
    return jsonOutput({ success: false, error: 'Server error: ' + err.message });
  }
}

// ── Action: verify ─────────────────────────────────────────────────────

function handleVerify(token) {
  if (isLockedOut(token)) {
    return { success: false, error: 'Too many attempts. Please try again later.' };
  }

  const record = findRecordByToken(token);

  if (!record) {
    registerFailedAttempt(token);
    return { success: false, error: 'Invalid access token.' };
  }

  if (record.forwarding_status !== '1') {
    registerFailedAttempt(token);
    return { success: false, error: 'This device is not active for forwarding.' };
  }

  clearFailedAttempts(token);
  const deviceEmail = String(record.device_email || '').trim();
  const address = deviceEmail || buildAlias(record.record_id);
  startSession(token, record.record_id, deviceEmail);

  return { success: true, recordId: record.record_id, address: address };
}

// ── Action: fetchCode ──────────────────────────────────────────────────

// Cap on how many matched emails we'll ever return, oldest dropped first.
const MAX_MATCHES_RETURNED = 10;

function handleFetchCode(token) {
  const session = getSession(token);
  if (!session) {
    return { found: false, error: 'Session expired. Please sign in again.' };
  }

  const address = session.deviceEmail || buildAlias(session.recordId);
  // Not restricted to is:unread — we want every matching email in the
  // window, not just ones not yet marked read.
  const query = 'to:' + address + ' newer_than:1d';

  const threads = GmailApp.search(query, 0, MAX_MATCHES_RETURNED);
  if (threads.length === 0) {
    return { found: false };
  }

  let allMessages = [];
  threads.forEach((thread) => {
    allMessages = allMessages.concat(thread.getMessages());
  });
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

function findRecordByToken(token) {
  const config = getConfig_();

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

function buildAlias(recordId) {
  const baseEmail = getConfig_().BASE_EMAIL;
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
