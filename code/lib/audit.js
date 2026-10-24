'use strict';
/*
Audit one deletion request:
  1. link resources to the subject (identifier tokens, resource references, catalog rows, account fallback)
  2. reconstruct each linked resource's state at audit_at from citable observations
  3. apply the deletion rules -> findings / remediation / verification steps
*/
const { tokensOf } = require('./identity');
const { makeStep, numberSteps } = require('./contract');
const { systemFor } = require('./loaders');

const RESOURCE_RE = /\b(account|search|analytics|support|export|data_flow|backup|audit_record|tombstone|legal_hold|marketing|email_delivery|cache|telemetry)_\d+\b/g;
const NULLISH = v => v == null || v === '' || v === 'null' || v === '[REDACTED]';
const ms = t => Date.parse(t);

// ---------------------------------------------------------------- categories
// Rule category for a resource, judged from what its observations describe.
function categoryOf(resourceId, obs) {
  const prefix = resourceId.replace(/_\d+$/, '');
  const has = re => obs.some(o => re.test(o.collection || '') || re.test(o.fields.record_type || '') || re.test(o.fields.storage_class || ''));
  switch (prefix) {
    case 'account': return 'USER_PROFILE';
    case 'search': return 'SEARCH_INDEX_ENTRY';
    case 'cache': return 'CACHE_ENTRY';
    case 'export': return 'USER_EXPORT';
    case 'marketing': return 'MARKETING_PROFILE';
    case 'data_flow': return 'DATA_FLOW';
    case 'backup': return 'BACKUP_ARCHIVE';
    case 'audit_record': return 'SECURITY_AUDIT_LOG';
    case 'legal_hold': return 'LEGAL_HOLD_RECORD';
    case 'tombstone': return 'ACCOUNT_TOMBSTONE';
    case 'email_delivery': return 'EMAIL_DELIVERY_LOG';
    case 'telemetry': return 'PRODUCT_TELEMETRY';
    case 'analytics':
      return has(/contact_lookup|MARKETING/) || obs.some(o => 'email_opt_in' in o.fields) ? 'MARKETING_PROFILE' : 'ANALYTICS_PROFILE';
    case 'support':
      if (has(/attachment|SUPPORT_ATTACHMENT/) || obs.some(o => o.fields.file_name || o.fields.file)) return 'SUPPORT_ATTACHMENT';
      if (has(/contact_query|deletion_marker/)) return 'SECONDARY_IDENTIFIER';
      return 'SUPPORT_MESSAGE';
    default: return null;
  }
}

const TREATMENT = {
  USER_PROFILE: 'DELETE', SECONDARY_IDENTIFIER: 'DELETE', SEARCH_INDEX_ENTRY: 'DELETE', CACHE_ENTRY: 'DELETE',
  SUPPORT_ATTACHMENT: 'DELETE', USER_EXPORT: 'DELETE', MARKETING_PROFILE: 'DELETE',
  SUPPORT_MESSAGE: 'REDACT', EMAIL_DELIVERY_LOG: 'REDACT', ACCOUNT_TOMBSTONE: 'REDACT',
  ANALYTICS_PROFILE: 'ANONYMIZE', PRODUCT_TELEMETRY: 'ANONYMIZE',
  SECURITY_AUDIT_LOG: 'RETAIN', LEGAL_HOLD_RECORD: 'RETAIN',
  DATA_FLOW: 'DISABLE', BACKUP_ARCHIVE: 'BLOCK',
};

// ---------------------------------------------------------------- per-observation facts
// What one observation says about its resource: present?, identifiable?, flow on?, restorable?
function factsOf(o, category) {
  const f = o.fields;
  const r = { present: null, identifiable: null, active: null };
  const result = String(f.result || '').toUpperCase();
  if (o.collection === 'record_check') {
    if (/NOT_FOUND|ABSENT|DELETED/.test(result)) r.present = false;
    else if (/FOUND|PRESENT|IDENTIFIABLE/.test(result)) r.present = true;
    if (result === 'IDENTIFIABLE') { r.present = true; r.identifiable = true; }
    if (/ANONYMIZED|REDACTED/.test(result)) { r.present = true; r.identifiable = false; }
    if (result === 'ACTIVE') { r.present = true; r.active = true; }
    if (/DISABLED|BLOCKED/.test(result)) { r.present = true; r.active = false; }
    return r;
  }
  if (o.source === 'activity') return o.facts;
  if ('status_code' in f) r.present = f.status_code === 200 && f.profile != null;
  else if ('http_status' in f) r.present = String(f.http_status) === '200';
  else if ('rows' in f) r.present = Number(f.rows) > 0;
  else if (f.result === 'hit' || f.result === 'miss') r.present = f.result === 'hit' || f.available === 'true';
  else if (f.hits) r.present = (f.hits.total || 0) > 0;
  else r.present = true;
  if ('profile' in f && f.profile == null) r.present = false;
  if (f.account_status === 'DELETED' && category === 'USER_PROFILE') r.present = false;
  if ('available' in f || 'download_available' in f) r.present = String(f.available ?? f.download_available) === 'true';
  if ('archive_present' in f && String(f.archive_present) === 'false') r.present = false;

  // identifiability for records kept under REDACT / ANONYMIZE / tombstone rules
  const direct = ['email', 'phone', 'email_hash', 'full_name', 'name', 'display_name', 'requester_name', 'requester_email', 'requester_phone', 'owner_email', 'customer_email', 'matched_value'];
  let ident = direct.some(k => k in f && !NULLISH(f[k]));
  if (category === 'ANALYTICS_PROFILE' || category === 'PRODUCT_TELEMETRY') {
    ident = ident || ['user_id', 'customer_reference'].some(k => k in f && !NULLISH(f[k]));
  }
  if ('direct_identifiers' in f) ident = Number(f.direct_identifiers) > 0;
  if (/pii_scan|identity_scan/.test(o.collection || '')) ident = f.detector === 'direct_identifier' || !NULLISH(f.matched_value);
  if (typeof f.message_text === 'string' && f.message_text !== '[REDACTED]' && tokensOf(f.message_text).size) ident = true;
  if (f.document) ident = ident || ['display_name', 'email'].some(k => !NULLISH(f.document[k]));
  r.identifiable = r.present === false ? null : ident;

  // flows and restore paths
  if ('enabled' in f) r.active = String(f.enabled) === 'true' || f.enabled === 1;
  if ('scheduler_registered' in f && String(f.scheduler_registered) === 'true') r.active = true;
  if ('restore_allowed' in f) r.active = String(f.restore_allowed) === 'true' || f.restore_allowed === 1 || f.restore_allowed === '1';
  if ('eligible' in f) r.active = String(f.eligible) === 'true' && String(f.deletion_block) !== 'true';
  if ('decision' in f) r.active = f.decision !== 'deny';
  return r;
}

// ---------------------------------------------------------------- activity facts
// Activity rows that state a checked fact (not a worker's claim about its own action).
function activityObservations(activity) {
  const out = [];
  for (const a of activity) {
    let facts = null, rid = a.resource_id;
    if (a.event_type === 'CHECK_RESTORE_ACCESS') facts = { present: true, active: /can still be restored/.test(a.details), identifiable: null };
    else if (a.event_type === 'CHECK_DATA_FLOW') facts = { present: true, active: /remains enabled/.test(a.details), identifiable: null };
    else if (a.event_type === 'RESTORE_BACKUP') {
      const m = /downstream resource (\S+?)\.?$/.exec(a.details);
      if (m) { rid = m[1]; facts = { present: true, active: null, identifiable: true }; }
    }
    if (!facts) continue;
    out.push({ evidence_id: a.activity_id, file_time: a.event_time, ts: a.event_time, source: 'activity',
      system_id: systemFor(rid) || a.target_system, resource_id: rid, collection: a.event_type, store: null,
      fields: { details: a.details }, facts });
  }
  return out;
}

// ---------------------------------------------------------------- linking
// The deletion workflow acts on a case's resources shortly before it reports: the account delete
// lands ~1.3h before reported_at, follow-up actions up to ~2h after. Its result mirrors the claim.
const WORKFLOW_BEFORE = 1.5 * 3600e3, WORKFLOW_AFTER = 2 * 3600e3;
const CLAIM_RESULT = { COMPLETE: 'SUCCESS', PARTIALLY_COMPLETE: 'PARTIAL', NOT_STARTED: 'FAILED' };

class Linker {
  constructor(observations, activity, identity, allRequests) {
    this.identity = identity;
    this.byResource = new Map();
    for (const o of observations) {
      if (!o.resource_id) continue;
      if (!this.byResource.has(o.resource_id)) this.byResource.set(o.resource_id, []);
      this.byResource.get(o.resource_id).push(o);
      o.tokens = tokensOf(o.fields);
    }
    this.scopes = observations.filter(o => o.source === 'sql_scope' || o.source === 'json_scope');
    this.sqlRows = observations.filter(o => o.source === 'sql');
    this.catalog = activity.filter(a => a.event_type === 'LINK_RESOURCE_IDENTITY');
    this.workerActions = activity.filter(a => a.source_system === 'deletion_worker');
    for (const a of this.workerActions) a._t = ms(a.event_time);
    this.requests = allRequests;
    this.ownerCache = new Map();
  }

  // Users that some identifier in the evidence ties this resource to.
  ownersOf(rid) {
    if (this.ownerCache.has(rid)) return this.ownerCache.get(rid);
    const owners = new Set();
    for (const o of this.byResource.get(rid) || []) {
      for (const t of o.tokens || []) for (const u of this.identity.byToken.get(t) || []) owners.add(u);
    }
    for (const a of this.catalog) if (a.resource_id === rid) {
      for (const t of tokensOf(a.details)) for (const u of this.identity.byToken.get(t) || []) owners.add(u);
    }
    this.ownerCache.set(rid, owners);
    return owners;
  }

  // Resources that identifiers tie to each user (built once).
  resourcesOf(userId) {
    if (!this.userResources) {
      this.userResources = new Map();
      const all = new Set([...this.byResource.keys(), ...this.catalog.map(a => a.resource_id)]);
      for (const rid of all) {
        for (const u of this.ownersOf(rid)) {
          if (!this.userResources.has(u)) this.userResources.set(u, new Set());
          this.userResources.get(u).add(rid);
        }
      }
    }
    return this.userResources.get(userId) || new Set();
  }

  // Owned resources the workflow acted on in r's window (cached per request).
  ownWorkflowResources(r) {
    this.ownWfCache = this.ownWfCache || new Map();
    const key = `${r.case_id}|${r.email}`;
    if (!this.ownWfCache.has(key)) {
      const uid = this.identity.resolveEmail(r.email, r.requested_at);
      const owned = uid ? this.resourcesOf(uid) : new Set();
      const lo = ms(r.reported_at) - WORKFLOW_BEFORE, hi = ms(r.reported_at) + WORKFLOW_AFTER;
      this.ownWfCache.set(key, new Set(this.workerActions
        .filter(a => owned.has(a.resource_id) && a._t >= lo && a._t <= hi).map(a => a.resource_id)));
    }
    return this.ownWfCache.get(key);
  }

  // Did the workflow, in r's window, act on another resource of the same kind that r's subject owns?
  hasOwnWorkflowResource(r, exceptRid) {
    const kind = exceptRid.replace(/_\d+$/, '_');
    for (const rid of this.ownWorkflowResources(r)) if (rid !== exceptRid && rid.startsWith(kind)) return true;
    return false;
  }

  // Requests whose workflow window contains this worker action (cached per action).
  requestsInWindow(a) {
    if (!a._win) {
      a._win = this.requests.filter(r => a._t >= ms(r.reported_at) - WORKFLOW_BEFORE && a._t <= ms(r.reported_at) + WORKFLOW_AFTER);
    }
    return a._win;
  }

  // Resources the deletion workflow touched for this request and that nothing ties to anyone else.
  workflowLinks(req, userId) {
    const out = [];
    const isReq = r => r.case_id === req.case_id && r.email === req.email;
    for (const a of this.workerActions) {
      const inWin = this.requestsInWindow(a);
      if (!inWin.some(isReq)) continue;
      const owners = this.ownersOf(a.resource_id);
      if (owners.size && !owners.has(userId)) continue;
      // A request whose subject already has its own identified resource of this kind acted on in
      // the same window is not a candidate. Account deletes also mirror the claimed status.
      const isAccount = a.resource_id.startsWith('account_');
      const candidates = inWin.filter(r => !this.hasOwnWorkflowResource(r, a.resource_id) &&
        (!isAccount || CLAIM_RESULT[r.reported_status] === a.reported_result));
      if (candidates.length === 1 && isReq(candidates[0])) out.push(a);
    }
    return out;
  }

  // Resources tied to the user, with the reason for each link.
  link(userId, req) {
    const tokens = this.identity.tokensFor(userId);
    const linked = new Map();
    const add = (rid, why) => { if (!linked.has(rid)) linked.set(rid, why); };
    for (const [rid, obs] of this.byResource) {
      for (const o of obs) {
        if ([...o.tokens].some(t => tokens.has(t))) { add(rid, `${o.evidence_id}:identifier`); break; }
      }
    }
    for (const a of this.catalog) {
      if ([...tokensOf(a.details)].some(t => tokens.has(t))) add(a.resource_id, `${a.activity_id}:catalog`);
    }
    // Records that point at an already-linked resource (e.g. search doc -> source account).
    for (const rid of [...linked.keys()]) {
      for (const o of this.byResource.get(rid) || []) {
        for (const ref of JSON.stringify(o.fields).match(RESOURCE_RE) || []) if (ref !== rid) add(ref, `${o.evidence_id}:reference`);
      }
    }
    // Fallback: resources the request's own deletion workflow acted on.
    const workflow = this.workflowLinks(req, userId);
    for (const a of workflow) add(a.resource_id, `${a.activity_id}:workflow`);
    const wfAccount = workflow.find(a => a.resource_id.startsWith('account_'));
    return { linked, workflowAccount: wfAccount ? wfAccount.resource_id : null };
  }
}

// ---------------------------------------------------------------- state at audit_at
function stateAt(rid, linker, auditAt) {
  const all = linker.byResource.get(rid) || [];
  const category = categoryOf(rid, all);
  const cutoff = ms(auditAt);
  const citable = all.filter(o => ms(o.ts) <= cutoff && ms(o.file_time) <= cutoff)
    .sort((a, b) => ms(a.ts) - ms(b.ts));
  let latest = null;
  if (citable.length) {
    const lastTs = ms(citable[citable.length - 1].ts);
    const sameTime = citable.filter(o => ms(o.ts) === lastTs).map(o => ({ o, f: factsOf(o, category) }));
    // Any copy still present (e.g. replica drift) wins over the copies that are gone.
    sameTime.sort((x, y) => (y.f.present === true) - (x.f.present === true) || (y.f.identifiable === true) - (x.f.identifiable === true));
    latest = sameTime[0];
  }
  // Absence by omission: with no explicit observation, the latest scoped snapshot of the
  // system that does not list the resource. An explicit "not found" is always cited first.
  if (!latest && TREATMENT[category] === 'DELETE') {
    const system = systemFor(rid);
    const scope = linker.scopes
      .filter(s => ms(s.ts) <= cutoff && ms(s.file_time) <= cutoff && coversSystem(s, system, linker))
      .sort((a, b) => ms(b.ts) - ms(a.ts))[0];
    if (scope && !(scope.fields.resource_ids || []).includes(rid)) {
      return { category, present: false, identifiable: null, active: null, evidence: scope.evidence_id, via: 'omission' };
    }
  }
  if (!latest) return { category, present: null, identifiable: null, active: null, evidence: '', via: 'none' };
  return { category, ...latest.f, evidence: latest.o.evidence_id, via: latest.o.collection };
}

function coversSystem(scope, system, linker) {
  if (scope.source === 'json_scope') return scope.system_id === system;
  const s = scope.fields.scope || {};
  if (Object.keys(s).length) return system in s;
  return linker.sqlRows.some(o => o.evidence_id === scope.evidence_id && o.system_id === system);
}

// ---------------------------------------------------------------- rules -> steps
function planSteps(states) {
  const steps = [];
  let incomplete = false;
  for (const [rid, st] of [...states].sort()) {
    const sys = systemFor(rid);
    const t = TREATMENT[st.category];
    if (!t) continue;
    const ev = st.evidence;
    const finding = (op, fix, verify) => {
      incomplete = true;
      steps.push(makeStep(op, sys, rid, ev), makeStep(fix, sys, rid), makeStep(verify, sys, rid));
    };
    const ok = verify => steps.push({ ...makeStep(verify, sys, rid, ev), _ok: true });
    if (t === 'DELETE') {
      if (st.present === true) finding('REPORT_REMAINING_RECORD', 'DELETE_RECORD', 'VERIFY_RECORD_ABSENT');
      else if (st.present === false || st.category === 'USER_PROFILE') ok('VERIFY_RECORD_ABSENT');
    } else if (t === 'REDACT' || t === 'ANONYMIZE') {
      const [fix, verify] = t === 'REDACT' ? ['REDACT_RECORD', 'VERIFY_RECORD_REDACTED'] : ['ANONYMIZE_RECORD', 'VERIFY_RECORD_ANONYMIZED'];
      if (st.present === true && st.identifiable) finding('REPORT_EXPOSED_PII', fix, verify);
      else if (st.present === true) ok(verify);
    } else if (t === 'RETAIN') {
      // Policy keeps these; check they survive unless evidence says they are already gone.
      if (st.present !== false) ok('VERIFY_RECORD_PRESENT');
    } else if (t === 'DISABLE') {
      if (st.active === true) finding('REPORT_ACTIVE_DATA_FLOW', 'DISABLE_DATA_FLOW', 'VERIFY_DATA_FLOW_DISABLED');
      else if (st.active === false) ok('VERIFY_DATA_FLOW_DISABLED');
    } else if (t === 'BLOCK') {
      if (st.active === true) finding('REPORT_RESTORE_RISK', 'BLOCK_RESTORE', 'VERIFY_RESTORE_BLOCKED');
      else if (st.active === false) ok('VERIFY_RESTORE_BLOCKED');
    }
  }
  // Future work in an INCOMPLETE case carries no evidence. A COMPLETE case can only state
  // checks it can prove, so unproven ones are dropped.
  const final = [];
  for (const s of steps) {
    const { _ok, ...step } = s;
    if (incomplete && step.phase !== 'FINDING') step.evidence_id = '';
    else if (!incomplete && !step.evidence_id) continue;
    final.push(step);
  }
  return { status: incomplete ? 'INCOMPLETE' : 'COMPLETE', steps: numberSteps(final) };
}

function auditCase(req, ctx) {
  const userId = ctx.identity.resolveEmail(req.email, req.requested_at);
  if (!userId) return { status: 'COMPLETE', steps: [], trace: { userId: null } };
  const { linked, workflowAccount } = ctx.linker.link(userId, req);
  const states = new Map();
  for (const rid of linked.keys()) states.set(rid, stateAt(rid, ctx.linker, req.audit_at));
  // One account per request: when the workflow names it, other accounts that are already gone
  // belong to earlier requests by the same subject. A still-present account is always kept.
  if (workflowAccount) {
    for (const [rid, st] of [...states]) {
      if (rid.startsWith('account_') && rid !== workflowAccount && st.present !== true) states.delete(rid);
    }
  }
  const plan = planSteps(states);
  return { ...plan, trace: { userId, linked: Object.fromEntries(linked), states: Object.fromEntries(states) } };
}

module.exports = { auditCase, Linker, activityObservations, categoryOf, factsOf, stateAt, planSteps };
