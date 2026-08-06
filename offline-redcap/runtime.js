/* Offline REDCap-style survey runtime. Embedded verbatim into every generated
   single-file survey. Relies on a global DATA object (injected by the generator)
   describing fields/forms/events. No external dependencies. */
(function () {
  'use strict';

  var STORAGE_KEY = 'offlineRedcap_' + (DATA.projectKey || 'default');
  var FS_DB = 'offlineRedcapFS_' + (DATA.projectKey || 'default');
  var store = loadStore();
  var currentRecordId = store.order[0] || null;
  var currentEvent = (DATA.events && DATA.events[0]) || '_default';
  var currentFormIndex = 0;
  var fileHandle = null; // File System Access API handle, when available

  var byForm = {}; // formName -> [field,...] in dictionary order
  DATA.fields.forEach(function (f) {
    (byForm[f.f] = byForm[f.f] || []).push(f);
  });
  var byName = {};
  DATA.fields.forEach(function (f) { byName[f.n] = f; });

  // Fields referenced as {field_name} inside another field's label/note are
  // rendered as a live input at that point (REDCap "embedded fields"), and
  // are not shown a second time at their normal position on the form.
  var embeddedNames = {};
  DATA.fields.forEach(function (f) {
    var text = (f.l || '') + ' ' + (f.note || '');
    (text.match(/\{([a-zA-Z0-9_]+)\}/g) || []).forEach(function (tok) {
      embeddedNames[tok.slice(1, -1)] = true;
    });
  });

  DATA.fields.forEach(function (f) {
    f._test = compileLogic(f.br);
    f._calcText = /@CALCTEXT\s*\(/i.test(f.ann || '');
    if (f.t === 'calc') f._calc = compileCalc(f.calcFormula || '');
  });

  // ---------- storage ----------
  function loadStore() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { records: {}, order: [] };
  }

  function saveStore() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (e) {
      setSaveIndicator('Local storage full/unavailable: ' + e.message, true);
      return;
    }
    setSaveIndicator('Autosaved locally ' + new Date().toLocaleTimeString());
    if (fileHandle) writeToFile();
  }

  function writeToFile() {
    fileHandle.createWritable().then(function (w) {
      return w.write(JSON.stringify(store, null, 1)).then(function () { return w.close(); });
    }).then(function () {
      setSaveIndicator('Autosaved locally and to file ' + new Date().toLocaleTimeString());
    }).catch(function (e) {
      setSaveIndicator('File autosave failed: ' + e.message + '. Still saving locally.', true);
    });
  }

  // ---------- file-handle persistence (IndexedDB), so file autosave survives reloads ----------
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(FS_DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbGet(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction('kv', 'readonly');
        var rq = tx.objectStore('kv').get(key);
        rq.onsuccess = function () { resolve(rq.result); };
        rq.onerror = function () { resolve(undefined); };
      });
    }).catch(function () { return undefined; });
  }
  function idbSet(key, val) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      });
    }).catch(function () {});
  }

  function tryResumeFileSync() {
    if (!window.showSaveFilePicker || !window.indexedDB) return;
    idbGet('handle').then(function (handle) {
      if (!handle) return;
      handle.queryPermission({ mode: 'readwrite' }).then(function (perm) {
        if (perm === 'granted') {
          fileHandle = handle;
          writeToFile();
          renderAll();
        } else {
          // Needs a user gesture to (re)grant permission. Try on the next click.
          var once = function () {
            document.removeEventListener('click', once);
            handle.requestPermission({ mode: 'readwrite' }).then(function (p2) {
              if (p2 === 'granted') { fileHandle = handle; writeToFile(); renderAll(); }
            }).catch(function () {});
          };
          document.addEventListener('click', once, { once: true });
        }
      }).catch(function () {});
    });
  }

  function enableFileSync() {
    if (!window.showSaveFilePicker) return;
    window.showSaveFilePicker({
      suggestedName: (DATA.projectTitle || 'offline_survey') + '_live_backup.json',
      types: [{ description: 'JSON backup', accept: { 'application/json': ['.json'] } }]
    }).then(function (handle) {
      fileHandle = handle;
      idbSet('handle', handle);
      writeToFile();
      renderAll();
    }).catch(function () { /* user cancelled, local autosave keeps working */ });
  }

  function newId() { return 'r' + Date.now() + Math.floor(Math.random() * 1000); }

  function ensureRecord(id) {
    if (!store.records[id]) {
      store.records[id] = { events: {} };
      if (store.order.indexOf(id) === -1) store.order.push(id);
    }
    return store.records[id];
  }
  function ensureEvent(rec, ev) {
    if (!rec.events[ev]) rec.events[ev] = { values: {} };
    return rec.events[ev];
  }

  function getVal(field) {
    var rec = store.records[currentRecordId];
    if (!rec) return undefined;
    var ev = rec.events[currentEvent];
    if (!ev) return undefined;
    return ev.values[field.n];
  }
  function setVal(field, value) {
    if (!currentRecordId) return;
    var rec = ensureRecord(currentRecordId);
    var ev = ensureEvent(rec, currentEvent);
    ev.values[field.n] = value;
    saveStore();
  }
  function recordLabel(id) {
    var rec = store.records[id];
    if (!rec) return id;
    for (var evName in rec.events) {
      var v = rec.events[evName].values[DATA.recordIdField];
      if (v) return v;
    }
    return '(unnamed)';
  }

  // ---------- shared REDCap-logic -> JS translation ----------
  // Handles two kinds of field reference: [field] (this event) and
  // [event_name][field] (a specific event, used in longitudinal projects).
  function redcapToJsExpr(raw) {
    var expr = raw;
    expr = expr.replace(/\[([a-zA-Z0-9_]+)\]\[([a-zA-Z0-9_]+)\]/g, function (m, ev, f) {
      return '__valEvent("' + ev + '","' + f + '")';
    });
    expr = expr.replace(/\[([a-zA-Z0-9_]+)\(([^)]+)\)\]/g, function (m, f, c) {
      return '__chk(r,"' + f + '","' + c.trim() + '")';
    });
    expr = expr.replace(/\[([a-zA-Z0-9_]+)\]/g, function (m, f) {
      return '__val(r,"' + f + '")';
    });
    expr = expr.replace(/isblankormissingcode/gi, '__blank');
    expr = expr.replace(/<>/g, ' !== ');
    expr = expr.replace(/(^|[^=!<>])=(?!=)/g, function (m, pre) { return pre + '=='; });
    expr = expr.replace(/\band\b/gi, '&&');
    expr = expr.replace(/\bor\b/gi, '||');
    expr = expr.replace(/(^|[\s(])not\b/gi, function (m, pre) { return pre + '!'; });
    return expr;
  }

  // f._test(cur, rec): cur = current event's values (flat), rec = the whole
  // record (all events), needed to resolve [event][field] cross-event refs.
  function compileLogic(raw) {
    if (!raw || !raw.trim()) return function () { return true; };
    try {
      var expr = redcapToJsExpr(raw);
      var fn = new Function('r', '__val', '__chk', '__blank', '__valEvent',
        'try{return !!(' + expr + ');}catch(e){return true;}');
      return function (cur, rec) {
        return fn(cur,
          function (rr, name) { return rr[name]; },
          function (rr, name, code) { var v = rr[name]; return (v && v[code]) ? '1' : '0'; },
          function (v) { return v === undefined || v === null || v === ''; },
          function (evName, name) {
            if (rec && rec.events[evName] && rec.events[evName].values[name] !== undefined) {
              return rec.events[evName].values[name];
            }
            return cur[name];
          });
      };
    } catch (e) {
      return function () { return true; };
    }
  }

  // ---------- generic calc-field evaluator (best effort) ----------
  var CALC_SUPPORTED_FNS = { round: 1, sum: 1, min: 1, max: 1, abs: 1, sqrt: 1, if: 1 };
  function compileCalc(raw) {
    if (!raw || !raw.trim()) return null;
    if (/datediff|today|now\s*\(|checkbox_count/i.test(raw)) return null; // known-unsupported
    try {
      var expr = redcapToJsExpr(raw);
      expr = expr.replace(/\^/g, '**');
      expr = expr.replace(/\bround\s*\(/gi, '__round(');
      expr = expr.replace(/\bsum\s*\(/gi, '__sum(');
      expr = expr.replace(/\bmin\s*\(/gi, '__min(');
      expr = expr.replace(/\bmax\s*\(/gi, '__max(');
      expr = expr.replace(/\babs\s*\(/gi, 'Math.abs(');
      expr = expr.replace(/\bsqrt\s*\(/gi, 'Math.sqrt(');
      expr = expr.replace(/\bif\s*\(/gi, '__if(');
      // bail out if any other unknown function-call-like identifier remains
      var fnCalls = expr.match(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g) || [];
      var unknown = fnCalls.some(function (m) {
        var name = m.replace(/\s*\($/, '');
        return ['__round', '__sum', '__min', '__max', 'Math.abs', 'Math.sqrt', '__if', '__val', '__chk', '__blank', '__valEvent'].indexOf(name) === -1;
      });
      if (unknown) return null;
      var fn = new Function('r', '__val', '__chk', '__blank', '__round', '__sum', '__min', '__max', '__if', '__valEvent',
        'return (' + expr + ');');
      return function (values) {
        try {
          var numify = function (v) { return v === undefined || v === '' ? undefined : (isNaN(v) ? v : parseFloat(v)); };
          var out = fn(values,
            function (rr, name) { return numify(rr[name]); },
            function (rr, name, code) { var v = rr[name]; return (v && v[code]) ? 1 : 0; },
            function (v) { return v === undefined || v === null || v === ''; },
            function (x, n) { n = n || 0; if (x === undefined || isNaN(x)) return undefined; var f = Math.pow(10, n); return Math.round(x * f) / f; },
            function () { var s = 0, any = false; for (var i = 0; i < arguments.length; i++) { if (arguments[i] !== undefined && !isNaN(arguments[i])) { s += Number(arguments[i]); any = true; } } return any ? s : undefined; },
            function () { var vals = Array.prototype.slice.call(arguments).filter(function (v) { return v !== undefined && !isNaN(v); }); return vals.length ? Math.min.apply(Math, vals) : undefined; },
            function () { var vals = Array.prototype.slice.call(arguments).filter(function (v) { return v !== undefined && !isNaN(v); }); return vals.length ? Math.max.apply(Math, vals) : undefined; },
            function (c, a, b) { return c ? a : b; },
            function (evName, name) { return numify(values[name]); });
          return (out === undefined || out === null || (typeof out === 'number' && isNaN(out))) ? '' : out;
        } catch (e) { return ''; }
      };
    } catch (e) {
      return null;
    }
  }

  function currentEventValuesSnapshot() {
    var rec = store.records[currentRecordId];
    if (!rec || !rec.events[currentEvent]) return {};
    return rec.events[currentEvent].values;
  }

  // ---------- CSV export (aims to match REDCap's own import-template column layout) ----------
  function csvEscape(v) {
    v = v === undefined || v === null ? '' : String(v);
    if (/[",\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
    return v;
  }
  function buildColumns() {
    var cols = [DATA.recordIdField];
    if (DATA.useEvents) cols.push('redcap_event_name');
    if (DATA.includeRepeatCols) { cols.push('redcap_repeat_instrument'); cols.push('redcap_repeat_instance'); }
    if (DATA.includeDagCol) cols.push('redcap_data_access_group');
    DATA.fields.forEach(function (f) {
      if (f.n !== DATA.recordIdField && f.t !== 'descriptive') {
        if (f.t === 'checkbox') f.ch.forEach(function (p) { cols.push(f.n + '___' + p[0]); });
        else cols.push(f.n);
      }
    });
    return cols;
  }
  function exportCSV() {
    var cols = buildColumns();
    var rows = [cols.join(',')];
    var events = DATA.useEvents ? DATA.events : ['_default'];
    store.order.forEach(function (id) {
      var rec = store.records[id];
      events.forEach(function (evName) {
        var ev = rec.events[evName];
        if (!ev) return;
        var hasAny = Object.keys(ev.values).length > 0;
        if (!hasAny) return;
        var row = [];
        cols.forEach(function (c) {
          if (c === DATA.recordIdField && cols.indexOf(c) === 0) { row.push(csvEscape(ev.values[DATA.recordIdField] || id)); return; }
          if (c === 'redcap_event_name') { row.push(csvEscape(evName)); return; }
          if (c === 'redcap_repeat_instrument' || c === 'redcap_repeat_instance' || c === 'redcap_data_access_group') { row.push(''); return; }
          var base = c.indexOf('___') > -1 ? c.split('___')[0] : c;
          var code = c.indexOf('___') > -1 ? c.split('___')[1] : null;
          var field = byName[base];
          var raw = ev.values[base];
          if (field && field.t === 'checkbox') {
            row.push(raw && raw[code] ? '1' : '0');
          } else {
            row.push(csvEscape(raw));
          }
        });
        rows.push(row.join(','));
      });
    });
    downloadBlob(rows.join('\r\n'), (DATA.projectTitle || 'offline_survey') + '_redcap_import.csv', 'text/csv');
  }

  function downloadBlob(content, filename, type) {
    var blob = new Blob([content], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  function exportJSON() {
    downloadBlob(JSON.stringify(store, null, 1), (DATA.projectTitle || 'offline_survey') + '_backup.json', 'application/json');
  }
  function importJSONFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        if (!parsed.records || !parsed.order) throw new Error('Not a recognised backup file');
        store = parsed;
        currentRecordId = store.order[0] || null;
        saveStore();
        renderAll();
      } catch (e) { alert('Could not load backup: ' + e.message); }
    };
    reader.readAsText(file);
  }

  // ---------- UI ----------
  var root = document.getElementById('app');

  function setSaveIndicator(text, isError) {
    var el = document.getElementById('saveIndicator');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#ffb3b3' : '';
  }

  function visibleForms() {
    if (!DATA.useEvents) return DATA.forms;
    if (!DATA.eventsMappingKnown) return DATA.forms;
    return DATA.forms.filter(function (f) {
      var evs = DATA.formEvents[f] || DATA.events;
      return evs.indexOf(currentEvent) > -1;
    });
  }

  function formHasData(formName) {
    var rec = store.records[currentRecordId];
    if (!rec) return false;
    var ev = rec.events[currentEvent];
    if (!ev) return false;
    return (byForm[formName] || []).some(function (f) {
      var v = ev.values[f.n];
      if (v === undefined || v === null || v === '') return false;
      if (typeof v === 'object') return Object.keys(v).some(function (k) { return v[k]; });
      return true;
    });
  }

  function niceFormName(n) {
    return n.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function renderAll() {
    root.innerHTML = '';
    var top = el('header', 'app-top');
    top.appendChild(el('h1', null, DATA.projectTitle || 'Offline Survey'));
    var saveInd = el('span', 'save-indicator'); saveInd.id = 'saveIndicator';
    saveInd.textContent = fileHandle ? 'Autosaving locally and to file' : 'Autosaving locally';
    top.appendChild(saveInd);
    var btnCsv = btn('Export CSV (for REDCap import)', exportCSV);
    var btnJson = btn('Backup JSON', exportJSON);
    var btnImport = btn('Restore JSON', function () { importInput.click(); });
    var importInput = document.createElement('input');
    importInput.type = 'file'; importInput.accept = '.json'; importInput.style.display = 'none';
    importInput.addEventListener('change', function () { if (importInput.files[0]) importJSONFile(importInput.files[0]); importInput.value = ''; });
    top.appendChild(btnCsv); top.appendChild(btnJson); top.appendChild(btnImport); top.appendChild(importInput);
    if (window.showSaveFilePicker) {
      top.appendChild(btn(fileHandle ? 'File autosave: on' : 'Enable file autosave', enableFileSync));
    }
    root.appendChild(top);

    var layout = el('div', 'layout');
    layout.appendChild(renderRecordsPanel());
    layout.appendChild(renderMain());
    root.appendChild(layout);
  }

  function renderRecordsPanel() {
    var aside = el('aside', 'records');
    aside.appendChild(el('h2', null, 'Records'));
    aside.appendChild(btn('+ New record', function () {
      var id = newId();
      ensureRecord(id);
      currentRecordId = id;
      currentFormIndex = 0;
      saveStore();
      renderAll();
    }));
    store.order.forEach(function (id) {
      var item = el('div', 'record-item' + (id === currentRecordId ? ' active' : ''));
      item.appendChild(el('span', null, recordLabel(id)));
      item.addEventListener('click', function () { currentRecordId = id; currentFormIndex = 0; renderAll(); });
      aside.appendChild(item);
    });
    return aside;
  }

  function renderMain() {
    var main = el('main', 'content');
    if (!currentRecordId) {
      main.appendChild(el('div', 'empty-state', 'Create a record to begin.'));
      return main;
    }
    if (DATA.useEvents && DATA.events.length > 1) {
      var tabs = el('div', 'event-tabs');
      DATA.events.forEach(function (ev) {
        var t = el('div', 'event-tab' + (ev === currentEvent ? ' active' : ''), ev);
        t.addEventListener('click', function () { currentEvent = ev; currentFormIndex = 0; renderAll(); });
        tabs.appendChild(t);
      });
      main.appendChild(tabs);
      if (!DATA.eventsMappingKnown) main.appendChild(el('div', 'hint', 'No event mapping detected. Every form is shown under every event. Fill each form under its correct event.'));
    }
    var forms = visibleForms();
    if (currentFormIndex >= forms.length) currentFormIndex = 0;
    var formName = forms[currentFormIndex];

    var nav = el('div', 'form-nav');
    nav.appendChild(btn('< Prev', function () { currentFormIndex = Math.max(0, currentFormIndex - 1); renderAll(); }, currentFormIndex === 0));
    var sel = document.createElement('select');
    forms.forEach(function (f, i) {
      var o = document.createElement('option');
      o.value = i; o.textContent = niceFormName(f) + (formHasData(f) ? ' ✓' : '');
      if (i === currentFormIndex) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { currentFormIndex = +sel.value; renderAll(); });
    nav.appendChild(sel);
    nav.appendChild(btn('Next >', function () { currentFormIndex = Math.min(forms.length - 1, currentFormIndex + 1); renderAll(); }, currentFormIndex === forms.length - 1));
    nav.appendChild(el('span', 'progress-pill', (currentFormIndex + 1) + ' / ' + forms.length));
    main.appendChild(nav);

    var panel = el('div', 'form-panel');
    panel.appendChild(el('h2', null, niceFormName(formName)));
    panel.id = 'formPanel';
    panel.dataset.form = formName;
    renderFormFields(panel, formName);
    main.appendChild(panel);

    var footer = el('div', 'footer-nav');
    footer.appendChild(btn('< Previous form', function () { currentFormIndex = Math.max(0, currentFormIndex - 1); renderAll(); }, currentFormIndex === 0));
    footer.appendChild(btn('Next form >', function () { currentFormIndex = Math.min(forms.length - 1, currentFormIndex + 1); renderAll(); }, currentFormIndex === forms.length - 1));
    main.appendChild(footer);

    return main;
  }

  function renderFormFields(panel, formName) {
    var fields = byForm[formName] || [];
    var i = 0;
    var lastSection = null;
    while (i < fields.length) {
      var f = fields[i];
      if (embeddedNames[f.n]) { i++; continue; }
      if (f.s && f.s !== lastSection) {
        panel.appendChild(el('div', 'section-header', f.s));
        lastSection = f.s;
      }
      if (f.mg && (f.t === 'radio' || f.t === 'checkbox')) {
        var group = [f];
        var j = i + 1;
        while (j < fields.length && fields[j].mg === f.mg && fields[j].t === f.t) { group.push(fields[j]); j++; }
        if (group.length > 1) {
          safeRender(function () { renderMatrix(panel, group); });
          i = j;
          continue;
        }
      }
      safeRender(function () { renderField(panel, f); });
      i++;
    }
    if (!fields.length) panel.appendChild(el('div', 'hint', 'No fields on this form.'));
  }

  function safeRender(fn) {
    try { fn(); } catch (e) {
      console.warn('Field render failed', e);
    }
  }

  function fieldVisible(f) {
    var cur = currentEventValuesSnapshot();
    var rec = store.records[currentRecordId];
    return f._test(cur, rec);
  }

  function renderMatrix(panel, group) {
    var wrap = el('div', 'field');
    var table = document.createElement('table');
    table.className = 'matrix-table';
    var thead = document.createElement('tr');
    thead.appendChild(document.createElement('th'));
    group[0].ch.forEach(function (pair) { var th = document.createElement('th'); th.textContent = pair[1]; thead.appendChild(th); });
    table.appendChild(thead);
    group.forEach(function (f) {
      var tr = document.createElement('tr');
      tr.dataset.mrow = f.n;
      if (!fieldVisible(f)) tr.style.display = 'none';
      var th = document.createElement('td');
      setRichText(th, f.l);
      tr.appendChild(th);
      var current = getVal(f);
      f.ch.forEach(function (pair) {
        var td = document.createElement('td');
        var input = document.createElement('input');
        input.type = f.t === 'checkbox' ? 'checkbox' : 'radio';
        input.name = 'mx_' + f.n;
        if (f.t === 'checkbox') {
          input.checked = !!(current && current[pair[0]]);
          input.addEventListener('change', function () {
            var v = getVal(f) || {};
            v[pair[0]] = input.checked;
            setVal(f, v);
            updateLiveState();
          });
        } else {
          input.checked = current === pair[0];
          input.addEventListener('change', function () { setVal(f, pair[0]); updateLiveState(); });
        }
        td.appendChild(input);
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    wrap.appendChild(table);
    panel.appendChild(wrap);
  }

  // REDCap piping: [field] and [event][field] tokens inside label/note/
  // descriptive HTML get replaced with the field's current (human-readable)
  // value. Only known field names are substituted, so unrelated bracket
  // text in the label is left untouched.
  function pipeText(str, cur, rec) {
    if (!str) return str;
    var out = str;
    out = out.replace(/\[([a-zA-Z0-9_]+)\]\[([a-zA-Z0-9_]+)\]/g, function (m, ev, name) {
      if (!byName[name]) return m;
      var v = (rec && rec.events[ev] && rec.events[ev].values[name] !== undefined) ? rec.events[ev].values[name] : cur[name];
      return formatPipedValue(name, v);
    });
    out = out.replace(/\[([a-zA-Z0-9_]+)\]/g, function (m, name) {
      if (!byName[name]) return m;
      return formatPipedValue(name, cur[name]);
    });
    return out;
  }
  function formatPipedValue(name, v) {
    var f = byName[name];
    if (v === undefined || v === null || v === '') return '';
    if (f.t === 'checkbox') {
      var labels = f.ch.filter(function (p) { return v[p[0]]; }).map(function (p) { return p[1]; });
      return labels.join(', ');
    }
    if (f.ch && f.ch.length) {
      var match = f.ch.filter(function (p) { return p[0] === v; })[0];
      return match ? match[1] : String(v);
    }
    return String(v);
  }

  // [field] is piping (shows the value as text). {field} is REDCap's
  // "embedded field" syntax: it splices in an actual live input control at
  // that spot instead. The two can't share the same reactive-refresh path,
  // since re-running pipeText would tear down and rebuild the embedded
  // inputs (losing focus) on every keystroke elsewhere on the form.
  function setRichText(el2, html) {
    var clean = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '');
    var hasEmbeds = /\{[a-zA-Z0-9_]+\}/.test(clean);
    var rec = store.records[currentRecordId];
    var piped = pipeText(clean, currentEventValuesSnapshot(), rec);
    if (!hasEmbeds && /\[[a-zA-Z0-9_]+\]/.test(clean)) el2.dataset.pipeTemplate = clean;
    el2.innerHTML = piped;
    if (hasEmbeds) embedFields(el2);
  }

  // Walks el2's text nodes and swaps any {field_name} token for a live
  // input control, leaving surrounding HTML (e.g. a table layout) intact.
  function embedFields(el2) {
    var walker = document.createTreeWalker(el2, NodeFilter.SHOW_TEXT, null);
    var textNodes = [];
    var node;
    while ((node = walker.nextNode())) {
      if (/\{[a-zA-Z0-9_]+\}/.test(node.nodeValue)) textNodes.push(node);
    }
    textNodes.forEach(function (tn) {
      var parts = tn.nodeValue.split(/(\{[a-zA-Z0-9_]+\})/g);
      if (parts.length <= 1) return;
      var frag = document.createDocumentFragment();
      parts.forEach(function (part) {
        var m = /^\{([a-zA-Z0-9_]+)\}$/.exec(part);
        if (m && byName[m[1]]) frag.appendChild(renderEmbeddedInput(byName[m[1]]));
        else if (part) frag.appendChild(document.createTextNode(part));
      });
      tn.parentNode.replaceChild(frag, tn);
    });
  }

  // Compact bound input for a field embedded inline in another field's text.
  function renderEmbeddedInput(f) {
    var wrap = document.createElement('span');
    wrap.className = 'embedded-input';
    wrap.dataset.field = f.n;
    if (!fieldVisible(f)) wrap.style.display = 'none';
    var current = getVal(f);
    function commit(v) { setVal(f, v); updateLiveState(); }

    if (f.t === 'yesno' || f.t === 'truefalse') {
      var yn = f.t === 'yesno' ? [['1', 'Yes'], ['0', 'No']] : [['1', 'True'], ['0', 'False']];
      yn.forEach(function (p) {
        var lbl = el('label', 'choice-opt embedded-opt');
        var input = document.createElement('input');
        input.type = 'radio'; input.name = 'em_' + f.n; input.value = p[0];
        input.checked = current === p[0];
        input.addEventListener('change', function () { commit(p[0]); });
        lbl.appendChild(input); lbl.appendChild(document.createTextNode(p[1]));
        wrap.appendChild(lbl);
      });
    } else if (f.t === 'dropdown') {
      var sel = document.createElement('select');
      sel.className = 'embedded-select';
      sel.appendChild(new Option('-- select --', ''));
      f.ch.forEach(function (p) { var o = new Option(p[1], p[0]); if (current === p[0]) o.selected = true; sel.appendChild(o); });
      sel.addEventListener('change', function () { commit(sel.value); });
      wrap.appendChild(sel);
    } else if (f.t === 'radio') {
      f.ch.forEach(function (p) {
        var lbl = el('label', 'choice-opt embedded-opt');
        var input = document.createElement('input');
        input.type = 'radio'; input.name = 'em_' + f.n; input.value = p[0];
        input.checked = current === p[0];
        input.addEventListener('change', function () { commit(p[0]); });
        lbl.appendChild(input); lbl.appendChild(document.createTextNode(p[1]));
        wrap.appendChild(lbl);
      });
    } else if (f.t === 'checkbox') {
      f.ch.forEach(function (p) {
        var lbl = el('label', 'choice-opt embedded-opt');
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!(current && current[p[0]]);
        input.addEventListener('change', function () {
          var v = getVal(f) || {}; v[p[0]] = input.checked; commit(v);
        });
        lbl.appendChild(input); lbl.appendChild(document.createTextNode(p[1]));
        wrap.appendChild(lbl);
      });
    } else if (f.t === 'notes') {
      var ta = document.createElement('textarea');
      ta.className = 'embedded-text';
      ta.value = current || '';
      ta.addEventListener('input', function () { commit(ta.value); });
      wrap.appendChild(ta);
    } else {
      var inp = document.createElement('input');
      inp.className = 'embedded-text';
      inp.type = f.t === 'text' ? textInputType(f.val) : 'text';
      inp.value = current || '';
      inp.addEventListener('input', function () { commit(inp.value); });
      wrap.appendChild(inp);
    }
    return wrap;
  }

  // Pulls the balanced-paren contents out of an @CALCTEXT(...) annotation.
  function extractCalcText(ann) {
    if (!ann) return '';
    var m = /@CALCTEXT\s*\(/i.exec(ann);
    if (!m) return '';
    var start = m.index + m[0].length;
    var depth = 1, i = start;
    while (i < ann.length && depth > 0) {
      if (ann[i] === '(') depth++;
      else if (ann[i] === ')') depth--;
      i++;
    }
    return ann.slice(start, i - 1).trim();
  }

  function calcDetails(formula) {
    var d = document.createElement('details');
    d.className = 'calc-details';
    var s = document.createElement('summary');
    s.textContent = 'Show calculation';
    d.appendChild(s);
    var pre = el('div', 'calc-formula', formula);
    d.appendChild(pre);
    return d;
  }

  function renderField(panel, f) {
    var wrap = el('div', 'field' + (f.hidden ? ' hidden-field' : ''));
    wrap.dataset.field = f.n;
    if (!fieldVisible(f)) wrap.style.display = 'none';

    if (f.t === 'descriptive') {
      var d = el('div', 'descriptive-box');
      setRichText(d, f.l);
      wrap.appendChild(d);
      panel.appendChild(wrap);
      return;
    }

    var label = document.createElement('label');
    label.className = 'flabel';
    setRichText(label, f.l);
    if (f.req) label.appendChild(el('span', 'required-mark', '*'));
    if (f.hidden) label.appendChild(el('span', 'pill pill-hidden', 'HIDDEN'));
    if (f._calcText || f.t === 'calc') label.appendChild(el('span', 'pill pill-calc', 'CALCULATED'));
    wrap.appendChild(label);
    if (f.note) { var noteEl = el('div', 'fnote'); setRichText(noteEl, f.note); wrap.appendChild(noteEl); }

    var current = getVal(f);

    if (f._calcText) {
      var ctx = document.createElement('input');
      ctx.type = 'text';
      ctx.value = current || '';
      ctx.addEventListener('input', function () { setVal(f, ctx.value); });
      wrap.appendChild(ctx);
      wrap.appendChild(el('div', 'calc-hint', 'Set by REDCap. Usually leave blank.'));
      var ctFormula = extractCalcText(f.ann);
      if (ctFormula) wrap.appendChild(calcDetails(ctFormula));
    } else if (f.t === 'calc') {
      if (f._calc) {
        var computed = f._calc(currentEventValuesSnapshot());
        if (computed !== '' && current !== String(computed)) setVal(f, String(computed));
        var disp = document.createElement('input');
        disp.type = 'text'; disp.value = computed === '' ? '' : String(computed); disp.disabled = true;
        wrap.appendChild(disp);
        wrap.appendChild(el('div', 'calc-hint', 'Calculated automatically.'));
      } else {
        var ct = document.createElement('input');
        ct.type = 'text';
        ct.value = current || '';
        ct.addEventListener('input', function () { setVal(f, ct.value); });
        wrap.appendChild(ct);
        wrap.appendChild(el('div', 'calc-hint', 'Formula too complex to run offline. Usually leave blank.'));
      }
      if (f.calcFormula) wrap.appendChild(calcDetails(f.calcFormula));
    } else if (f.t === 'yesno' || f.t === 'radio' || f.t === 'dropdown' || f.t === 'truefalse') {
      var choices = f.t === 'yesno' ? [['1', 'Yes'], ['0', 'No']] : f.t === 'truefalse' ? [['1', 'True'], ['0', 'False']] : f.ch;
      if (f.t === 'dropdown') {
        var sel = document.createElement('select');
        sel.appendChild(new Option('-- select --', ''));
        choices.forEach(function (p) { var o = new Option(p[1], p[0]); if (current === p[0]) o.selected = true; sel.appendChild(o); });
        sel.addEventListener('change', function () { setVal(f, sel.value); updateLiveState(); });
        wrap.appendChild(sel);
      } else {
        var row = el('div', 'choice-row');
        choices.forEach(function (p) {
          var lbl = el('label', 'choice-opt');
          var input = document.createElement('input');
          input.type = 'radio'; input.name = f.n; input.value = p[0];
          input.checked = current === p[0];
          input.addEventListener('change', function () { setVal(f, p[0]); updateLiveState(); });
          lbl.appendChild(input);
          lbl.appendChild(document.createTextNode(p[1]));
          row.appendChild(lbl);
        });
        wrap.appendChild(row);
      }
    } else if (f.t === 'checkbox') {
      var crow = el('div', 'choice-row');
      f.ch.forEach(function (p) {
        var lbl = el('label', 'choice-opt');
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!(current && current[p[0]]);
        input.addEventListener('change', function () {
          var v = getVal(f) || {};
          v[p[0]] = input.checked;
          setVal(f, v);
          updateLiveState();
        });
        lbl.appendChild(input);
        lbl.appendChild(document.createTextNode(p[1]));
        crow.appendChild(lbl);
      });
      wrap.appendChild(crow);
    } else if (f.t === 'notes') {
      var ta = document.createElement('textarea');
      ta.value = current || '';
      ta.addEventListener('input', function () { setVal(f, ta.value); updateLiveState(); });
      wrap.appendChild(ta);
    } else if (f.t === 'file') {
      var ft = document.createElement('input');
      ft.type = 'text'; ft.placeholder = 'Filename or description';
      ft.value = current || '';
      ft.addEventListener('input', function () { setVal(f, ft.value); updateLiveState(); });
      wrap.appendChild(ft);
      wrap.appendChild(el('div', 'filebox', 'Files are not stored here. Note a filename or description.'));
    } else if (f.t === 'slider') {
      var labels = f.ch.length ? f.ch.map(function (p) { return p[1]; }) : ['0', '50', '100'];
      var range = document.createElement('input');
      range.type = 'range'; range.min = '0'; range.max = '100';
      range.value = current !== undefined ? current : '50';
      var readout = el('span', 'fnote', range.value);
      range.addEventListener('input', function () { readout.textContent = range.value; setVal(f, range.value); });
      wrap.appendChild(range);
      wrap.appendChild(readout);
      var lblRow = el('div', 'choice-row');
      lblRow.appendChild(el('span', 'fnote', labels[0] || ''));
      if (labels[2]) { lblRow.appendChild(el('span', 'fnote', labels[1] || '')); lblRow.appendChild(el('span', 'fnote', labels[2])); }
      wrap.appendChild(lblRow);
    } else {
      // text, and any unrecognised field type: generic fallback so unforeseen dictionaries don't break
      var inp = document.createElement('input');
      inp.type = f.t === 'text' ? textInputType(f.val) : 'text';
      if (f.min !== '' && f.min !== undefined) inp.min = f.min;
      if (f.max !== '' && f.max !== undefined) inp.max = f.max;
      if (f.val === 'number_1dp') inp.step = '0.1';
      else if (f.val === 'number_2dp') inp.step = '0.01';
      else if (f.val === 'integer') inp.step = '1';
      inp.value = current || '';
      inp.addEventListener('input', function () { setVal(f, inp.value); updateLiveState(); });
      wrap.appendChild(inp);
      if (f.t !== 'text') wrap.appendChild(el('div', 'fnote', 'Unrecognised field type "' + f.t + '". Shown as text.'));
    }
    panel.appendChild(wrap);
  }

  function textInputType(val) {
    switch (val) {
      case 'integer': case 'number': case 'number_1dp': case 'number_2dp': return 'number';
      case 'date_dmy': case 'date_ymd': case 'date_mdy': return 'date';
      case 'datetime_ymd': case 'datetime_dmy': return 'datetime-local';
      case 'time': return 'time';
      case 'email': return 'email';
      case 'phone_australia': case 'phone': return 'tel';
      default: return 'text';
    }
  }

  // Re-evaluates branching visibility and piped text in place, without
  // rebuilding the DOM, so typing in a field never loses focus.
  function updateLiveState() {
    var panel = document.getElementById('formPanel');
    if (!panel) return;
    var cur = currentEventValuesSnapshot();
    var rec = store.records[currentRecordId];
    panel.querySelectorAll('[data-field]').forEach(function (wrap) {
      var f = byName[wrap.dataset.field];
      if (!f) return;
      wrap.style.display = f._test(cur, rec) ? '' : 'none';
    });
    panel.querySelectorAll('[data-mrow]').forEach(function (tr) {
      var f = byName[tr.dataset.mrow];
      if (!f) return;
      tr.style.display = f._test(cur, rec) ? '' : 'none';
    });
    panel.querySelectorAll('[data-pipe-template]').forEach(function (node) {
      node.innerHTML = pipeText(node.dataset.pipeTemplate, cur, rec);
    });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function btn(text, onClick, disabled) {
    var b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = text;
    b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  if (!currentRecordId) {
    var id0 = newId();
    ensureRecord(id0);
    currentRecordId = id0;
  }
  tryResumeFileSync();
  renderAll();
})();
