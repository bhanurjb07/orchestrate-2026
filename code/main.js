#!/usr/bin/env node
'use strict';
/*
Ghost Data Still Exists - deletion audit pipeline.

Usage:
  node code/main.js                                  # all requests -> ./output.csv
  node code/main.js --input dataset/sample_deletion_requests.csv --output sample_pred.csv
  node code/main.js --trace case_05                  # print linking/state details for one case
*/
const fs = require('fs');
const path = require('path');
const { readCsv, writeCsv } = require('./lib/csv');
const { OUTPUT_HEADER, validate } = require('./lib/contract');
const { loadEvidence, loadTables } = require('./lib/loaders');
const { IdentityIndex } = require('./lib/identity');
const { classifyRequest } = require('./lib/classify');
const { Linker, activityObservations, auditCase } = require('./lib/audit');

const ROOT = path.resolve(__dirname, '..');
const DATASET = path.join(ROOT, 'dataset');

function parseArgs(argv) {
  const a = { input: path.join(DATASET, 'deletion_requests.csv'), output: path.join(ROOT, 'output.csv'), trace: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') a.input = argv[++i];
    else if (argv[i] === '--output') a.output = argv[++i];
    else if (argv[i] === '--trace') a.trace = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return a;
}

function caseOrder(a, b) {
  const n = s => Number((/\d+$/.exec(s) || [0])[0]);
  return n(a.case_id) - n(b.case_id) || (a.case_id < b.case_id ? -1 : 1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tables = loadTables(DATASET);
  const { observations, skipped } = loadEvidence(DATASET, path.join(__dirname, 'cache', 'extracted'));
  if (skipped.length) console.error(`note: no extracted facts yet for ${skipped.length} image/PDF files (${skipped.join(', ')})`);
  const identity = new IdentityIndex(tables.identities, tables.auditLog);
  const requests = readCsv(args.input).rows.sort(caseOrder);
  // Workflow windows are disambiguated against every known request, not just this batch.
  const known = new Map();
  for (const f of ['deletion_requests.csv', 'sample_deletion_requests.csv']) {
    for (const r of readCsv(path.join(DATASET, f)).rows) known.set(`${r.case_id}|${r.email}`, r);
  }
  // A row with replay_of (custom test cases) is a variant of a known request: it shares that
  // request's workflow identity and does not join the pool as an extra competitor.
  const byCase = new Map([...known.values()].map(r => [r.case_id, r]));
  for (const r of requests) {
    if (!r.replay_of) continue;
    const orig = byCase.get(r.replay_of);
    if (!orig) throw new Error(`${r.case_id}: replay_of ${r.replay_of} is not a known request`);
    r._key = `${orig.case_id}|${orig.email}`;
  }
  const allRequests = requests.filter(r => !r.replay_of).map(r => known.get(`${r.case_id}|${r.email}`) || r);
  for (const r of known.values()) if (!allRequests.includes(r)) allRequests.push(r);
  const deletionRequests = allRequests.filter(r => classifyRequest(r.request_text).decision !== 'NOT_DELETION');
  const linker = new Linker(observations.concat(activityObservations(tables.activity)), tables.activity, identity, deletionRequests);
  const ctx = { identity, linker };
  const out = [];
  const counts = {};
  for (const req of requests) {
    const cls = classifyRequest(req.request_text);
    let status, steps, trace;
    // Only a clear deletion request authorizes an audit; unclear text is never treated as one.
    if (cls.decision !== 'DELETION') {
      if (cls.decision === 'UNCLEAR') console.error(`warn: ${req.case_id} request text unclear, treated as NOT_APPLICABLE`);
      status = 'NOT_APPLICABLE'; steps = []; trace = { classification: cls };
    } else {
      ({ status, steps, trace } = auditCase(req, ctx));
    }
    const errs = validate(status, steps);
    if (errs.length) throw new Error(`${req.case_id}: invalid output: ${errs.join('; ')}`);
    counts[status] = (counts[status] || 0) + 1;
    out.push({ case_id: req.case_id, deletion_status: status, steps_json: JSON.stringify(steps) });
    if (args.trace === req.case_id) console.log(JSON.stringify({ req, status, steps, trace }, null, 2));
  }
  writeCsv(args.output, OUTPUT_HEADER, out);
  console.error(`wrote ${out.length} rows to ${path.relative(ROOT, args.output) || args.output}: ${JSON.stringify(counts)}`);
  // Record the run for usage_report.md (the pipeline itself makes no model calls).
  if (path.resolve(args.output) === path.join(ROOT, 'output.csv')) {
    fs.writeFileSync(path.join(__dirname, 'cache', 'last_run.json'), JSON.stringify({
      at: new Date().toISOString(), requests: out.length, statuses: counts, llm_calls: 0,
      extracted_files: fs.readdirSync(path.join(__dirname, 'cache', 'extracted')).length,
      missing_extractions: skipped,
    }, null, 2) + '\n');
  }
}

main();
