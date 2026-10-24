#!/usr/bin/env node
'use strict';
/*
Run the custom evaluation cases in custom_cases.json:
  1. build the request CSV (sample request + the case's change) and the expected-output CSV
  2. run the pipeline on the requests
  3. score predictions against the expected outputs with the sample scorer

Usage: node code/evaluation/custom.js [--verbose]
Writes its working files to code/evaluation/custom_run/.
*/
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readCsv, writeCsv } = require('../lib/csv');
const { makeStep, numberSteps, OUTPUT_HEADER } = require('../lib/contract');
const { score, format } = require('./main');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'custom_run');

function main() {
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'custom_cases.json'), 'utf8'));
  const samples = new Map(readCsv(path.join(ROOT, 'dataset', 'sample_deletion_requests.csv')).rows.map(r => [r.case_id, r]));
  const gold = new Map(readCsv(path.join(ROOT, 'dataset', 'sample_output.csv')).rows.map(r => [r.case_id, r]));
  fs.mkdirSync(OUT, { recursive: true });

  const requests = [], expected = [];
  for (const c of spec.cases) {
    const base = samples.get(c.replay_of);
    if (!base) throw new Error(`${c.case_id}: unknown replay_of ${c.replay_of}`);
    requests.push({ ...base, ...c.change, case_id: c.case_id, replay_of: c.replay_of });
    if (c.expected_from_gold) {
      const g = gold.get(c.expected_from_gold);
      expected.push({ case_id: c.case_id, deletion_status: g.deletion_status, steps_json: g.steps_json });
    } else {
      const steps = numberSteps(c.steps.map(([op, sys, rid, ev]) => makeStep(op, sys, rid, ev)));
      expected.push({ case_id: c.case_id, deletion_status: c.expected_status, steps_json: JSON.stringify(steps) });
    }
  }
  const reqFile = path.join(OUT, 'requests.csv'), expFile = path.join(OUT, 'expected.csv'), predFile = path.join(OUT, 'predictions.csv');
  writeCsv(reqFile, Object.keys(requests[0]), requests);
  writeCsv(expFile, OUTPUT_HEADER, expected);

  execFileSync(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'main.js'), '--input', reqFile, '--output', predFile], { stdio: 'inherit' });
  const r = score(predFile, expFile);
  console.log(format(r, process.argv.includes('--verbose')));
  process.exitCode = r.sequenceAcc === 1 ? 0 : 1;
}

main();
