'use strict';
// Output contract shared by the pipeline and the scorer.

const OP_STATE = {
  REPORT_REMAINING_RECORD: ['FINDING', 'PRESENT'],
  REPORT_EXPOSED_PII: ['FINDING', 'PRESENT'],
  REPORT_ACTIVE_DATA_FLOW: ['FINDING', 'ACTIVE'],
  REPORT_RESTORE_RISK: ['FINDING', 'ACTIVE'],
  DISABLE_DATA_FLOW: ['REMEDIATION', 'DISABLED'],
  BLOCK_RESTORE: ['REMEDIATION', 'BLOCKED'],
  DELETE_RECORD: ['REMEDIATION', 'ABSENT'],
  REDACT_RECORD: ['REMEDIATION', 'REDACTED'],
  ANONYMIZE_RECORD: ['REMEDIATION', 'ANONYMIZED'],
  VERIFY_RECORD_ABSENT: ['VERIFICATION', 'ABSENT'],
  VERIFY_RECORD_PRESENT: ['VERIFICATION', 'PRESENT'],
  VERIFY_RECORD_REDACTED: ['VERIFICATION', 'REDACTED'],
  VERIFY_RECORD_ANONYMIZED: ['VERIFICATION', 'ANONYMIZED'],
  VERIFY_DATA_FLOW_DISABLED: ['VERIFICATION', 'DISABLED'],
  VERIFY_RESTORE_BLOCKED: ['VERIFICATION', 'BLOCKED'],
};
const OP_RANK = Object.fromEntries(Object.keys(OP_STATE).map((op, i) => [op, i]));
const STEP_FIELDS = ['step_no', 'phase', 'system_id', 'resource_id', 'operation', 'state', 'evidence_id'];
const STATUSES = new Set(['COMPLETE', 'INCOMPLETE', 'NOT_APPLICABLE']);
const OUTPUT_HEADER = ['case_id', 'deletion_status', 'steps_json'];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Canonical order: operation (table order, which also orders phases), then system_id, then resource_id.
function sortSteps(steps) {
  return [...steps].sort((a, b) =>
    OP_RANK[a.operation] - OP_RANK[b.operation] ||
    cmp(a.system_id, b.system_id) ||
    cmp(a.resource_id, b.resource_id));
}

function makeStep(operation, system_id, resource_id, evidence_id = '') {
  const [phase, state] = OP_STATE[operation];
  return { step_no: 0, phase, system_id, resource_id, operation, state, evidence_id };
}

function numberSteps(steps) {
  return sortSteps(steps).map((s, i) => ({ ...s, step_no: i + 1 }));
}

function isStep(s) {
  return s && typeof s === 'object' && !Array.isArray(s) && STEP_FIELDS.every(f => f in s);
}

// Returns a list of contract violations for one output row.
function validate(status, steps) {
  const errs = [];
  if (!STATUSES.has(status)) errs.push(`bad status ${JSON.stringify(status)}`);
  if (!Array.isArray(steps)) return errs.concat('steps_json is not an array');
  if (status === 'NOT_APPLICABLE' && steps.length) errs.push('NOT_APPLICABLE must have []');
  steps.forEach((s, idx) => {
    const i = idx + 1;
    if (!isStep(s) || Object.keys(s).length !== STEP_FIELDS.length) { errs.push(`step ${i}: wrong fields`); return; }
    if (s.step_no !== i) errs.push(`step ${i}: step_no=${s.step_no}`);
    const exp = OP_STATE[s.operation];
    if (!exp) { errs.push(`step ${i}: unknown operation ${s.operation}`); return; }
    if (s.phase !== exp[0] || s.state !== exp[1]) errs.push(`step ${i}: ${s.operation} needs phase/state ${exp}`);
    const future = status === 'INCOMPLETE' && s.phase !== 'FINDING';
    if (future && s.evidence_id) errs.push(`step ${i}: future step must have empty evidence_id`);
    if (!future && !s.evidence_id) errs.push(`step ${i}: missing evidence_id`);
  });
  if (status === 'COMPLETE' && steps.some(s => isStep(s) && s.phase !== 'VERIFICATION')) {
    errs.push('COMPLETE must contain only VERIFICATION steps');
  }
  const keys = steps.filter(isStep).map(s => [OP_RANK[s.operation] ?? 99, s.system_id, s.resource_id]);
  const sorted = [...keys].sort((a, b) => a[0] - b[0] || cmp(a[1], b[1]) || cmp(a[2], b[2]));
  if (JSON.stringify(keys) !== JSON.stringify(sorted)) {
    errs.push('steps not in canonical order (operation, system_id, resource_id)');
  }
  return errs;
}

module.exports = { OP_STATE, OP_RANK, STEP_FIELDS, STATUSES, OUTPUT_HEADER, sortSteps, makeStep, numberSteps, isStep, validate };
