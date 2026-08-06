/* Generator page logic: parses a REDCap Data Dictionary CSV (+ optional Project
   XML export) entirely client-side and packages a standalone offline survey
   HTML file for download. No external dependencies. */
(function () {
  'use strict';

  var dictInput = document.getElementById('dictFile');
  var xmlInput = document.getElementById('xmlFile');
  var titleInput = document.getElementById('titleOverride');
  var useEventsChk = document.getElementById('useEvents');
  var manualEventsRow = document.getElementById('manualEventsRow');
  var manualEventsInput = document.getElementById('manualEventNames');
  var includeRepeatChk = document.getElementById('includeRepeatCols');
  var includeDagChk = document.getElementById('includeDagCol');
  var genBtn = document.getElementById('generateBtn');
  var statusEl = document.getElementById('status');
  var summaryEl = document.getElementById('summary');

  var dictRows = null;
  var xmlInfo = null;

  setupDropzone(document.getElementById('dictDropzone'), dictInput, function (file) {
    return readFile(file).then(function (text) {
      dictRows = parseCSV(text);
      report();
      updateManualEventsVisibility();
    }).catch(function (e) { dictRows = null; setStatus('Could not read data dictionary: ' + e.message, true); throw e; });
  }, function () { dictRows = null; report(); });

  setupDropzone(document.getElementById('xmlDropzone'), xmlInput, function (file) {
    return readFile(file).then(function (text) {
      xmlInfo = parseProjectXML(text);
      if (xmlInfo && xmlInfo.events && xmlInfo.events.length) useEventsChk.checked = true;
      report();
      updateManualEventsVisibility();
    }).catch(function (e) { xmlInfo = null; setStatus('Could not read project XML: ' + e.message, true); throw e; });
  }, function () { xmlInfo = null; report(); updateManualEventsVisibility(); });

  // Wires a dropzone div (click-to-browse + drag & drop) to a hidden file
  // input, shows the picked filename/size, and offers a "Remove" affordance.
  function setupDropzone(zone, input, onFile, onRemove) {
    var emptyEl = zone.querySelector('.dz-empty');
    var filledEl = zone.querySelector('.dz-filled');
    var fileNameEl = zone.querySelector('.dz-file');
    var fileMetaEl = zone.querySelector('.dz-file-meta');
    var removeBtn = zone.querySelector('.dz-remove');

    function showFile(file) {
      emptyEl.style.display = 'none';
      filledEl.style.display = '';
      fileNameEl.textContent = file.name;
      fileMetaEl.textContent = (file.size / 1024).toFixed(1) + ' KB';
      zone.classList.add('has-file');
    }
    function clear() {
      emptyEl.style.display = '';
      filledEl.style.display = 'none';
      zone.classList.remove('has-file');
      input.value = '';
    }
    function accept(file) {
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      showFile(file);
      Promise.resolve(onFile(file)).catch(function () { clear(); });
    }

    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', function () { if (input.files[0]) accept(input.files[0]); });
    removeBtn.addEventListener('click', function (e) { e.stopPropagation(); clear(); onRemove(); });

    ['dragenter', 'dragover'].forEach(function (evt) {
      zone.addEventListener(evt, function (e) { e.preventDefault(); e.stopPropagation(); zone.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      zone.addEventListener(evt, function (e) { e.preventDefault(); e.stopPropagation(); zone.classList.remove('dragover'); });
    });
    zone.addEventListener('drop', function (e) {
      var file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) accept(file);
    });
  }

  useEventsChk.addEventListener('change', updateManualEventsVisibility);
  function updateManualEventsVisibility() {
    var mappingKnown = !!(xmlInfo && xmlInfo.events && xmlInfo.events.length && dictRows && xmlEventsMatchForms());
    manualEventsRow.style.display = (useEventsChk.checked && !mappingKnown) ? '' : 'none';
  }
  function xmlEventsMatchForms() {
    if (!xmlInfo || !dictRows) return false;
    var knownForms = {}; dictRows.forEach(function (r) { if (r['Form Name']) knownForms[r['Form Name'].trim()] = true; });
    return Object.keys(xmlInfo.formEvents || {}).some(function (f) { return knownForms[f]; });
  }

  var genBtnLabel = genBtn.textContent;
  genBtn.addEventListener('click', function () {
    if (!dictRows || !dictRows.length) { setStatus('Upload a data dictionary CSV first.', true); return; }
    try {
      var opts = {
        useEvents: useEventsChk.checked,
        manualEventNames: manualEventsInput.value,
        includeRepeatCols: includeRepeatChk.checked,
        includeDagCol: includeDagChk.checked
      };
      var built = buildData(dictRows, xmlInfo, titleInput.value.trim(), opts);
      setGenerating(true);
      Promise.all([fetchText('runtime.js'), fetchText('runtime.css')]).then(function (r) {
        var html = assembleHTML(built, r[0], r[1]);
        var fname = (built.projectTitle || 'offline_survey').replace(/[^a-z0-9_-]+/gi, '_') + '.html';
        downloadBlob(html, fname, 'text/html');
        setStatus('Generated ' + fname + ' (' + (html.length / 1024).toFixed(0) + ' KB). Check your downloads.', false);
      }).catch(function (e) { setStatus('Failed to package runtime: ' + e.message, true); })
        .then(function () { setGenerating(false); });
    } catch (e) {
      setStatus('Failed to build survey: ' + e.message, true);
    }
  });

  function setGenerating(isGenerating) {
    genBtn.disabled = isGenerating;
    genBtn.innerHTML = isGenerating
      ? '<span class="loader"><span></span><span></span><span></span><span></span><span></span></span>'
      : genBtnLabel;
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error || new Error('read error')); };
      r.readAsText(file);
    });
  }
  function fetchText(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
      return r.text();
    });
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
  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.className = isError ? 'err' : 'ok';
  }

  // ---------- CSV parsing (handles quoted fields, embedded commas/newlines) ----------
  function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    text = text.replace(/^﻿/, '');
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
        } else {
          field += c;
        }
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\r') { /* skip */ }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    var header = rows[0];
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      if (rows[r].length === 1 && rows[r][0] === '') continue;
      var obj = {};
      for (var c2 = 0; c2 < header.length; c2++) obj[header[c2]] = rows[r][c2] !== undefined ? rows[r][c2] : '';
      out.push(obj);
    }
    return out;
  }

  // ---------- Project XML parsing (best effort; REDCap ODM/CDISC export) ----------
  function parseProjectXML(text) {
    try {
      var doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.querySelector('parsererror')) return null;
      var title = null;
      var studyName = doc.querySelector('GlobalVariables > StudyName, StudyName');
      if (studyName) title = studyName.textContent.trim();

      var formDefs = {};
      doc.querySelectorAll('FormDef').forEach(function (fd) {
        var oid = fd.getAttribute('OID');
        var name = fd.getAttribute('Name');
        if (oid) formDefs[oid] = name || oid;
      });

      var events = [];
      var formEvents = {};
      doc.querySelectorAll('StudyEventDef').forEach(function (sed) {
        var evName = sed.getAttribute('Name') || sed.getAttribute('OID');
        if (!evName) return;
        events.push(evName);
        sed.querySelectorAll('FormRef').forEach(function (fr) {
          var foid = fr.getAttribute('FormOID');
          var formLabel = formDefs[foid] || foid || '';
          var guess = oidToFormName(foid, formLabel);
          if (!formEvents[guess]) formEvents[guess] = [];
          if (formEvents[guess].indexOf(evName) === -1) formEvents[guess].push(evName);
        });
      });

      return { title: title, events: events, formEvents: formEvents };
    } catch (e) {
      return null;
    }
  }
  function oidToFormName(oid, fallbackLabel) {
    if (!oid) return (fallbackLabel || '').toLowerCase().replace(/\s+/g, '_');
    var m = /^Form\.(.+)$/i.exec(oid);
    if (m) return m[1].toLowerCase();
    return oid.toLowerCase();
  }

  // ---------- Build DATA object from dictionary rows ----------
  function buildData(rows, xml, titleOverride, opts) {
    opts = opts || {};
    var fields = [];
    var forms = [];
    rows.forEach(function (row) {
      var name = (row['Variable / Field Name'] || '').trim();
      if (!name) return;
      var type = (row['Field Type'] || 'text').trim();
      var form = (row['Form Name'] || 'form').trim();
      if (forms.indexOf(form) === -1) forms.push(form);
      var annotation = row['Field Annotation'] || '';
      var hidden = /@HIDDEN(-SURVEY)?\b/i.test(annotation);
      var choicesRaw = row['Choices, Calculations, OR Slider Labels'] || '';
      var choices = [];
      if (type === 'radio' || type === 'dropdown' || type === 'checkbox') {
        choicesRaw.split('|').forEach(function (part) {
          var idx = part.indexOf(',');
          if (idx === -1) return;
          var code = part.slice(0, idx).trim();
          var label = part.slice(idx + 1).trim();
          if (code) choices.push([code, label]);
        });
      } else if (type === 'slider' && choicesRaw.trim()) {
        choicesRaw.split('|').forEach(function (part) { choices.push(['', part.trim()]); });
      }
      fields.push({
        n: name,
        f: form,
        s: (row['Section Header'] || '').trim(),
        t: type,
        l: row['Field Label'] || name,
        ch: choices,
        note: (row['Field Note'] || '').trim(),
        val: (row['Text Validation Type OR Show Slider Number'] || '').trim(),
        min: (row['Text Validation Min'] || '').trim(),
        max: (row['Text Validation Max'] || '').trim(),
        req: /^y$/i.test((row['Required Field?'] || '').trim()),
        br: (row['Branching Logic (Show field only if...)'] || '').trim(),
        mg: (row['Matrix Group Name'] || '').trim(),
        hidden: hidden,
        ident: /^y$/i.test((row['Identifier?'] || '').trim()),
        ann: annotation,
        calcFormula: type === 'calc' ? choicesRaw : ''
      });
    });
    if (!fields.length) throw new Error('No usable fields found in that CSV. Is it a REDCap Data Dictionary export?');

    var eventsMappingKnown = false;
    var events = ['_default'];
    var formEvents = {};
    if (xml && xml.events && xml.events.length) {
      var knownForms = {}; forms.forEach(function (f) { knownForms[f] = true; });
      var matched = 0;
      Object.keys(xml.formEvents).forEach(function (f) { if (knownForms[f]) matched++; });
      if (matched > 0) {
        events = xml.events;
        eventsMappingKnown = true;
        forms.forEach(function (f) { formEvents[f] = xml.formEvents[f] && xml.formEvents[f].length ? xml.formEvents[f] : events.slice(); });
      }
    }

    var useEvents = opts.useEvents;
    if (useEvents === undefined) useEvents = eventsMappingKnown;
    if (useEvents) {
      if (!eventsMappingKnown) {
        var manual = (opts.manualEventNames || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        if (!manual.length) throw new Error('This project uses events, but no event names were detected from an XML and none were typed in manually.');
        events = manual;
      }
    } else {
      events = ['_default'];
      formEvents = {};
      eventsMappingKnown = false;
    }

    return {
      projectTitle: titleOverride || (xml && xml.title) || 'Offline Survey',
      projectKey: (titleOverride || (xml && xml.title) || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      recordIdField: fields[0].n,
      fields: fields,
      forms: forms,
      useEvents: !!useEvents,
      events: events,
      formEvents: formEvents,
      eventsMappingKnown: eventsMappingKnown,
      includeRepeatCols: !!opts.includeRepeatCols,
      includeDagCol: !!opts.includeDagCol
    };
  }

  function report() {
    if (!dictRows) { summaryEl.textContent = ''; return; }
    var forms = {}; dictRows.forEach(function (r) { if (r['Form Name']) forms[r['Form Name']] = true; });
    var lines = [];
    lines.push(dictRows.length + ' fields across ' + Object.keys(forms).length + ' forms.');
    var calcCount = dictRows.filter(function (r) { return r['Field Type'] === 'calc'; }).length;
    var hiddenCount = dictRows.filter(function (r) { return /@HIDDEN(-SURVEY)?\b/i.test(r['Field Annotation'] || ''); }).length;
    if (calcCount) lines.push(calcCount + ' calculated field(s), evaluated automatically where possible, otherwise marked for manual entry.');
    if (hiddenCount) lines.push(hiddenCount + ' hidden field(s), shown inline with a HIDDEN marker.');
    if (xmlInfo) {
      if (xmlInfo.events && xmlInfo.events.length) {
        var mappingKnown = xmlEventsMatchForms();
        lines.push('Project XML: ' + xmlInfo.events.length + ' event(s) detected (' + xmlInfo.events.join(', ') + ')' +
          (mappingKnown ? ', matched to this dictionary\'s forms.' : '. Could not match them to this dictionary\'s form names, so forms will show under every event.'));
      } else lines.push('Project XML loaded but no events found in it.');
      if (xmlInfo.title) lines.push('Project title from XML: ' + xmlInfo.title);
    } else {
      lines.push('No Project XML uploaded. If this project uses REDCap Events, tick "Project uses Events" below and type the event names, or upload the XML for automatic detection.');
    }
    summaryEl.textContent = lines.join(' ');
  }

  var FONT_LINKS = '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">';

  function assembleHTML(data, runtimeJs, runtimeCss) {
    var titleSafe = escapeHtml(data.projectTitle);
    return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' + titleSafe + ' (offline)</title>' +
      FONT_LINKS +
      '<style>' + runtimeCss + '</style></head>' +
      '<body><div id="app"></div>' +
      '<script>var DATA = ' + JSON.stringify(data) + ';<\/script>' +
      '<script>' + runtimeJs + '<\/script>' +
      '</body></html>';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
})();
