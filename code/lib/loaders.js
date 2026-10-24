'use strict';
/*
Turn every participant-facing evidence source into a flat list of observations:

  { evidence_id, file_time, ts, source, system_id, resource_id, collection, store, fields }

- evidence_id : file_id from evidence_files.csv (or activity_id for system_activity rows)
- file_time   : capture time of the whole file (manifest)
- ts          : time this particular fact was observed (inner snapshot / line / observed_at)
- store       : primary / replica table name for SQL captures, else null
- fields      : the record's own key/values (nested objects kept)

Log lines that share a trace id are merged into one observation so that a
"lookup started (key=email)" line is joined with its "lookup completed (resource_id)" line.
*/
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { readCsv } = require('./csv');

const SYSTEM_BY_PREFIX = {
  account: 'account_service', search: 'search_service', analytics: 'analytics_platform',
  support: 'support_platform', export: 'export_service', data_flow: 'integration_service',
  backup: 'backup_service', audit_record: 'security_service', tombstone: 'identity_service',
  legal_hold: 'legal_service', marketing: 'marketing_platform', email_delivery: 'email_delivery_service',
  cache: 'cache_service', object: 'object_storage', telemetry: 'telemetry_service',
};

function systemFor(resourceId) {
  const m = /^(.*)_\d+$/.exec(resourceId || '');
  return m ? SYSTEM_BY_PREFIX[m[1]] || null : null;
}

// ---------- SQL captures ----------
function loadSql(file, meta, out) {
  const text = fs.readFileSync(file, 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec(text);
  const tables = db.prepare("select name from sqlite_master where type='table'").all().map(r => r.name);
  const scope = {};
  if (tables.includes('snapshot_scope')) {
    for (const r of db.prepare('select * from snapshot_scope').all()) scope[r.origin_system] = r.captured_at;
  }
  const captured = (/Captured at:\s*(\S+)/.exec(text) || [])[1] || meta.captured_at;
  for (const t of tables) {
    if (t === 'snapshot_scope') continue;
    const rows = db.prepare(`select * from "${t}"`).all();
    for (const r of rows) {
      let fields = { ...r };
      let collection = t, system = systemFor(r.resource_id);
      if ('record_json' in r) {
        fields = JSON.parse(r.record_json);
        collection = r.collection_name;
        system = r.origin_system || system;
      }
      out.push({
        evidence_id: meta.file_id, file_time: meta.captured_at,
        ts: scope[system] || captured,
        source: 'sql', system_id: system, resource_id: r.resource_id,
        collection, store: t, fields,
      });
    }
    // Table present but empty for this snapshot still proves absence for its systems.
  }
  out.push({ evidence_id: meta.file_id, file_time: meta.captured_at, ts: captured, source: 'sql_scope',
    system_id: null, resource_id: null, collection: null, store: null,
    fields: { tables, scope } });
  db.close();
}

// ---------- JSON records ----------
function loadJson(file, meta, out) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const push = (system, resource, collection, ts, fields, store = null) => out.push({
    evidence_id: meta.file_id, file_time: meta.captured_at, ts: ts || meta.captured_at, source: 'json',
    system_id: system || systemFor(resource), resource_id: resource, collection, store, fields,
  });
  if (Array.isArray(j.snapshots)) {                       // snapshot bundles
    for (const s of j.snapshots) {
      for (const r of s.records) {
        // Operational history rows describe a record in another system.
        if (r.record_type && r.system) push(r.system, r.resource_id, 'record_check', r.recorded_at || s.captured_at, r);
        else push(s.data_store, r.resource_id, s.collection, s.captured_at, r);
      }
      // An empty snapshot still tells us the collection was inspected at that time.
      out.push({ evidence_id: meta.file_id, file_time: meta.captured_at, ts: s.captured_at, source: 'json_scope',
        system_id: s.data_store, resource_id: null, collection: s.collection, store: null,
        fields: { resource_ids: s.records.map(r => r.resource_id) } });
    }
  } else if (j.service_exports) {                         // service resource exports
    for (const [system, groups] of Object.entries(j.service_exports)) {
      for (const [collection, rows] of Object.entries(groups)) {
        for (const r of rows) push(system, r.resource_id, collection, r.observed_at, r);
      }
    }
  } else if (Array.isArray(j.records) && j.records[0] && 'record_type' in j.records[0]) { // ledgers
    for (const r of j.records) push(r.system, r.resource_id, 'record_check', r.recorded_at, r);
  } else if (Array.isArray(j.records)) {                  // single-collection captures
    for (const r of j.records) push(null, r.resource_id, j.collection, j.captured_at, r);
  } else {
    throw new Error(`unknown JSON shape in ${file}`);
  }
}

// ---------- plain-text handover ----------
function loadTxt(file, meta, out) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^-\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const [, ts, system, resource, recordType, result, subject] = m;
    out.push({ evidence_id: meta.file_id, file_time: meta.captured_at, ts, source: 'txt',
      system_id: system, resource_id: resource, collection: 'record_check', store: null,
      fields: { record_type: recordType, result, subject_reference: subject.trim() } });
  }
}

// ---------- logs ----------
function kvPairs(s) {
  const o = {};
  const re = /([A-Za-z_][\w.]*)=("((?:\\.|[^"\\])*)"|[^\s"]+)/g;
  let m;
  while ((m = re.exec(s))) o[m[1]] = m[3] !== undefined ? m[3].replace(/\\"/g, '"') : m[2];
  return o;
}

function parseLogLine(line) {
  const m = /^(\d{4}-\d\d-\d\dT[\d:]+Z)\s+(.*)$/.exec(line);
  if (!m) return null;
  const ts = m[1], rest = m[2];
  let f, service, trace, event;
  let x;
  if (rest.startsWith('{')) {                                         // structured JSON
    f = JSON.parse(rest); service = f.service || f.logger; trace = f.trace_id; event = f.event;
  } else if ((x = /^\[(\w+)\]\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+(\w+):\s*(.*)$/.exec(rest))) { // [LVL] [svc] [trace] event:
    f = kvPairs(x[5]); service = x[2]; trace = x[3]; event = x[4];
  } else if ((x = /^\|?\s*(\w+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\w+)\s*\|\s*(.*)$/.exec(rest))) { // pipes
    f = kvPairs(x[5]); service = x[2]; trace = x[3]; event = x[4];
  } else if ((x = /^<\d+>\d+\s+\S+\s+(\S+)\s+(\S+)\s+-\s+-\s+(.*)$/.exec(rest))) {           // syslog
    f = kvPairs(x[3]); service = x[1]; trace = x[2]; event = f.event;
  } else if ((x = /^requestId=(\S+)\s+level=\w+\s+function=(\S+)\s+message="(.*)"$/.exec(rest))) { // cloud runtime
    f = kvPairs(x[3].replace(/\\"/g, '"')); service = x[2]; trace = x[1]; event = f.event;
  } else {                                                            // key=value
    f = kvPairs(rest); service = f.service; trace = f.trace_id; event = f.event;
  }
  return { ts, service, trace, event, fields: f };
}

function loadLog(file, meta, out) {
  const traces = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const p = parseLogLine(line);
    if (!p || p.service === 'log_router' || p.service === 'readback_collector') continue;
    if (p.event === 'record_lookup') {                                // explicit record checks
      out.push({ evidence_id: meta.file_id, file_time: meta.captured_at, ts: p.ts, source: 'log',
        system_id: p.fields.system, resource_id: p.fields.resource_id, collection: 'record_check', store: null,
        fields: p.fields });
      continue;
    }
    const key = p.trace || `${p.ts}|${p.service}`;
    if (!traces.has(key)) traces.set(key, { service: p.service, ts: p.ts, events: [], fields: {} });
    const t = traces.get(key);
    t.events.push(p.event);
    Object.assign(t.fields, p.fields);
    if (p.fields.resource_id) t.ts = p.ts;                            // time of the result line
  }
  for (const [trace, t] of traces) {
    const rid = t.fields.resource_id;
    if (!rid) continue;
    out.push({ evidence_id: meta.file_id, file_time: meta.captured_at, ts: t.ts, source: 'log',
      system_id: systemFor(rid) || t.service, resource_id: rid, collection: t.events.join('>'), store: null,
      fields: { ...t.fields, trace_id: trace, service: t.service } });
  }
}

// ---------- images / PDFs: facts extracted once and cached ----------
function loadExtracted(meta, cacheDir, out) {
  const cache = path.join(cacheDir, `${meta.file_id}.json`);
  if (!fs.existsSync(cache)) return false;
  const facts = JSON.parse(fs.readFileSync(cache, 'utf8'));
  for (const r of facts.records || []) {
    out.push({ evidence_id: meta.file_id, file_time: meta.captured_at, ts: r.observed_at || meta.captured_at,
      source: 'extracted', system_id: r.system_id || systemFor(r.resource_id), resource_id: r.resource_id,
      collection: r.collection || 'extracted', store: null, fields: r });
  }
  return true;
}

function loadEvidence(datasetDir, cacheDir) {
  const manifest = readCsv(path.join(datasetDir, 'evidence_files.csv')).rows;
  const out = [], skipped = [];
  for (const meta of manifest) {
    const file = path.join(datasetDir, meta.file_path);
    const ext = path.extname(file).toLowerCase();
    if (ext === '.sql') loadSql(file, meta, out);
    else if (ext === '.json') loadJson(file, meta, out);
    else if (ext === '.txt') loadTxt(file, meta, out);
    else if (ext === '.log') loadLog(file, meta, out);
    else if (!loadExtracted(meta, cacheDir, out)) skipped.push(meta.file_id);
  }
  return { observations: out, manifest, skipped };
}

function loadTables(datasetDir) {
  const read = f => readCsv(path.join(datasetDir, f)).rows;
  return {
    identities: read('user_identities.csv'),
    auditLog: read('user_audit_log.csv'),
    activity: read('system_activity.csv'),
    rules: read('deletion_rules.csv'),
  };
}

module.exports = { loadEvidence, loadTables, parseLogLine, systemFor };
