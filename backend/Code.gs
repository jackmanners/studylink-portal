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
 */

// ── Configuration ──────────────────────────────────────────────────────

const REDCAP_API_URL = 'https://your-redcap-instance.org/api/';
const REDCAP_API_TOKEN = 'YOUR_REDCAP_API_TOKEN';

// The master inbox's own address, e.g. 'study@gmail.com'.
// Device aliases are derived as local+recordId@domain (Gmail "+" aliasing).
const BASE_EMAIL = 'study@gmail.com';

// REDCap field holding each participant's access token.
const ACCESS_TOKEN_FIELD = 'patient_token';

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
  startSession(token, record.record_id);

  return { success: true, recordId: record.record_id };
}

// ── Action: fetchCode ──────────────────────────────────────────────────

function handleFetchCode(token) {
  const recordId = getSession(token);
  if (!recordId) {
    return { found: false, error: 'Session expired. Please sign in again.' };
  }

  const alias = buildAlias(recordId);
  const query = 'to:' + alias + ' is:unread newer_than:1d';

  const threads = GmailApp.search(query, 0, 5);
  if (threads.length === 0) {
    return { found: false };
  }

  // Most recent thread, most recent unread message in it.
  const messages = threads[0].getMessages();
  let target = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isUnread()) {
      target = messages[i];
      break;
    }
  }
  if (!target) {
    return { found: false };
  }

  const subject = target.getSubject();
  const body = target.getPlainBody();
  const code = extractCode(body) || extractCode(subject);

  target.markRead();

  return {
    found: true,
    code: code || null,
    subject: subject,
    body: body.substring(0, 2000)
  };
}

// ── REDCap lookup ─────────────────────────────────────────────────────────

function findRecordByToken(token) {
  const payload = {
    token: REDCAP_API_TOKEN,
    content: 'record',
    format: 'json',
    type: 'flat',
    filterLogic: '[' + ACCESS_TOKEN_FIELD + ']=\'' + token.replace(/'/g, "\\'") + '\'',
    'fields[0]': 'record_id',
    'fields[1]': 'forwarding_status',
    returnFormat: 'json'
  };

  const response = UrlFetchApp.fetch(REDCAP_API_URL, {
    method: 'post',
    payload: payload,
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('Could not reach REDCap.');
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
  return records[0];
}

// ── Helpers ─────────────────────────────────────────────────────────────

function buildAlias(recordId) {
  const at = BASE_EMAIL.indexOf('@');
  const local = BASE_EMAIL.substring(0, at);
  const domain = BASE_EMAIL.substring(at + 1);
  return local + '+' + recordId + '@' + domain;
}

function extractCode(text) {
  if (!text) return null;
  const match = text.match(/\b\d{4,6}\b/);
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

function startSession(token, recordId) {
  CacheService.getScriptCache().put('session_' + token, String(recordId), SESSION_TTL_SEC);
}

function getSession(token) {
  return CacheService.getScriptCache().get('session_' + token);
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
