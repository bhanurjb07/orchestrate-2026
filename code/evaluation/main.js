#!/usr/bin/env node
'use strict';
/*
Score a predictions CSV against the sample answers.

Usage:
  node code/evaluation/main.js                          # ./output.csv vs dataset/sample_output.csv
  node code/evaluation/main.js --pred my.csv --verbose  # per-case missing/extra steps
  node code/evaluation/main.js --report out.md          # also write a Markdown summary

Only cases present in the gold file are scored. Metrics:
  status accuracy   - deletion_status matches
  step P/R/F1       - steps matched as whole tuples (phase, system, resource, op, state, evidence)
  resource P/R/F1   - same but ignoring evidence_id (did we find the right things?)
  field accuracy    - for steps aligned by (system_id, resource_id, operation), share of
                      phase / state / evidence_id fields that agree
  sequence accuracy - whole steps_json array identical, order included
Exit code is 0 only when sequence accuracy is 100%.
*/
const fs = require('fs');
const path = require('path');
const { readCsv } = require('../lib/csv');
const { OUTPUT_HEADER, isStep, validate } = require('../lib/contract');

const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const a = { pred: path.join(ROOT, 'sample_pred.csv'), gold: path.join(ROOT, 'dataset', 'sample_output.csv'), verbose: false, report: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--verbose') a.verbose = true;
    else if (k === '--pred') a.pred = argv[++i];
    else if (k === '--gold') a.gold = argv[++i];
    else if (k === '--report') a.report = argv[++i];
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

const tup = (s, withEvidence = true) => {
  const t = [s.phase, s.system_id, s.resource_id, s.operation, s.state];
  return JSON.stringify(withEvidence ? t.concat(s.evidence_id) : t);
};

function counter(items) {
  const m = new Map();
  for (const x of items) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

function overlap(a, b) {
  let n = 0;
  for (const [k, v] of a) n += Math.min(v, b.get(k) || 0);
  return n;
}

function prf(tp, nPred, nGold) {
  const p = nPred ? tp / nPred : 1, r = nGold ? tp / nGold : 1;
  return [p, r, p + r ? (2 * p * r) / (p + r) : 0];
}

const caseNum = c => [c.length, c];

function score(predPath, goldPath) {
  const gold = new Map(readCsv(goldPath).rows.map(r => [r.case_id, r]));
  const { header, rows } = readCsv(predPath);
  const pred = new Map(rows.map(r => [r.case_id, r]));
  const out = { headerOk: JSON.stringify(header) === JSON.stringify(OUTPUT_HEADER) };
  let statusOk = 0, seqOk = 0, fieldOk = 0, fieldTotal = 0;
  const step = { tp: 0, pred: 0, gold: 0 }, res = { tp: 0, pred: 0, gold: 0 };
  const confusion = new Map(), failures = [], invalid = new Map();

  const ids = [...gold.keys()].sort((a, b) => {
    const [x, y] = [caseNum(a), caseNum(b)];
    return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0);
  });
  for (const cid of ids) {
    const gStatus = gold.get(cid).deletion_status;
    const gSteps = JSON.parse(gold.get(cid).steps_json);
    const pRow = pred.get(cid);
    let pStatus = 'MISSING', pSteps = [];
    if (pRow) {
      pStatus = pRow.deletion_status;
      try { pSteps = JSON.parse(pRow.steps_json); } catch { invalid.set(cid, ['steps_json is not valid JSON']); }
      const errs = validate(pStatus, pSteps);
      if (errs.length) invalid.set(cid, (invalid.get(cid) || []).concat(errs));
      if (!Array.isArray(pSteps)) pSteps = [];
    }
    const valid = pSteps.filter(isStep);
    const ck = `${gStatus}|${pStatus}`;
    confusion.set(ck, (confusion.get(ck) || 0) + 1);
    if (gStatus === pStatus) statusOk++;
    if (gStatus === pStatus && valid.length === pSteps.length && sameOrder(gSteps, valid)) seqOk++;

    for (const [withEv, acc] of [[true, step], [false, res]]) {
      const gc = counter(gSteps.map(s => tup(s, withEv)));
      const pc = counter(valid.map(s => tup(s, withEv)));
      acc.tp += overlap(gc, pc); acc.pred += valid.length; acc.gold += gSteps.length;
    }

    const byKey = new Map(valid.map(s => [JSON.stringify([s.system_id, s.resource_id, s.operation]), s]));
    for (const s of gSteps) {
      const m = byKey.get(JSON.stringify([s.system_id, s.resource_id, s.operation]));
      for (const f of ['phase', 'state', 'evidence_id']) { fieldTotal++; if (m && m[f] === s[f]) fieldOk++; }
    }

    const gSet = new Set(gSteps.map(s => tup(s))), pSet = new Set(valid.map(s => tup(s)));
    const missing = [...gSet].filter(x => !pSet.has(x)).sort();
    const extra = [...pSet].filter(x => !gSet.has(x)).sort();
    if (gStatus !== pStatus || missing.length || extra.length || !sameOrder(gSteps, valid)) {
      failures.push({ cid, gStatus, pStatus, missing, extra });
    }
  }
  const n = gold.size;
  return Object.assign(out, {
    cases: n,
    missing: ids.filter(c => !pred.has(c)).length,
    statusAcc: statusOk / n,
    sequenceAcc: seqOk / n,
    stepPrf: prf(step.tp, step.pred, step.gold),
    resourcePrf: prf(res.tp, res.pred, res.gold),
    fieldAcc: fieldTotal ? fieldOk / fieldTotal : 1,
    confusion, failures, invalid,
  });
}

// Key order is irrelevant to the grader, so compare step tuples in array order.
function sameOrder(g, p) {
  return JSON.stringify(g.map(s => tup(s))) === JSON.stringify(p.map(s => tup(s)));
}

const pct = x => (100 * x).toFixed(1) + '%';

function format(r, verbose) {
  const lines = [
    `cases scored      : ${r.cases}  (missing in prediction: ${r.missing})`,
    `header ok         : ${r.headerOk}`,
    `status accuracy   : ${pct(r.statusAcc)}`,
    `step  P/R/F1      : ${r.stepPrf.map(pct).join(' / ')}`,
    `resource P/R/F1   : ${r.resourcePrf.map(pct).join(' / ')}  (evidence ignored)`,
    `field accuracy    : ${pct(r.fieldAcc)}  (phase/state/evidence on aligned steps)`,
    `sequence accuracy : ${pct(r.sequenceAcc)}`,
    `contract errors   : ${r.invalid.size} case(s)`,
    'status confusion (gold -> pred):',
  ];
  for (const [k, c] of [...r.confusion].sort()) {
    const [g, p] = k.split('|');
    lines.push(`  ${g.padEnd(15)} -> ${p.padEnd(15)} ${c}`);
  }
  for (const [cid, errs] of [...r.invalid].sort()) lines.push(`  INVALID ${cid}: ${errs.join('; ')}`);
  if (verbose) {
    for (const f of r.failures) {
      lines.push('', `${f.cid}: gold=${f.gStatus} pred=${f.pStatus}`);
      for (const m of f.missing) lines.push(`   - missing ${m}`);
      for (const e of f.extra) lines.push(`   + extra   ${e}`);
    }
  } else {
    lines.push(`failing cases: ${r.failures.map(f => f.cid).join(', ') || 'none'}`);
  }
  return lines.join('\n');
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const r = score(a.pred, a.gold);
  const text = format(r, a.verbose);
  console.log(text);
  if (a.report) fs.writeFileSync(a.report, `# Sample score\n\n\`\`\`text\n${text}\n\`\`\`\n`, 'utf8');
  process.exitCode = r.sequenceAcc === 1 ? 0 : 1;
}

if (require.main === module) main();
module.exports = { score, format };
