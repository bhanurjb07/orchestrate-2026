#!/usr/bin/env node
'use strict';
/*
One-time fact extraction for evidence the main pipeline cannot read as text.

  PDFs   -> text decoded locally with pdfjs, facts parsed with rules (no LLM).
  Images -> one Gemini vision call per image, structured JSON output.

Each file's facts are cached in code/cache/extracted/<file_id>.json; a file with a cache entry
is never sent again. Every model call is appended to code/cache/usage.jsonl for usage_report.md.

Configuration comes from the environment, loaded from the repo-root .env (see .env.example):
  GEMINI_API_KEY   required for images
  GEMINI_MODEL     optional, default gemini-2.5-flash

Usage:
  node code/extract/run.js            # extract whatever is missing
  node code/extract/run.js --pdf-only # PDFs only, no API calls
  node code/extract/run.js --force    # re-extract everything (spends tokens again for images)
  node code/extract/run.js --renormalize  # rebuild image records from cached model output (no API)
*/
const fs = require('fs');
const path = require('path');
const { readCsv } = require('../lib/csv');
const { pdfLines } = require('./pdfText');
const { systemFor } = require('../lib/loaders');

const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const DATASET = path.join(ROOT, 'dataset');
const CACHE = path.join(__dirname, '..', 'cache', 'extracted');
const USAGE = path.join(__dirname, '..', 'cache', 'usage.jsonl');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

const RESOURCE_RE = /\b(account|search|analytics|support|export|data_flow|backup|audit_record|tombstone|legal_hold|marketing|email_delivery|cache|telemetry|object)_\d+\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+\d[\d\s().-]{6,}\d/g;
const USER_RE = /\buser_\d+\b/g;
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

const uniq = a => [...new Set(a)];
const pad = n => String(n).padStart(2, '0');

// "25 Aug 2027 04 | 03 UTC" (pdfjs splits the time at the colon) -> ISO
function isoDate(s) {
  const m = /(\d{1,2}) (\w{3}) (\d{4})(?: (\d{2}) \| (\d{2}))?/.exec(s || '');
  if (!m || !MONTHS[m[2]]) return null;
  return `${m[3]}-${pad(MONTHS[m[2]])}-${pad(m[1])}T${m[4] || '00'}:${m[5] || '00'}:00Z`;
}

// ---------------------------------------------------------------- PDFs (rules, no LLM)
function pdfFacts(meta, pages, catalog) {
  const lines = pages.flat();
  const text = lines.join('\n');
  const find = re => uniq(text.match(re) || []);
  const detail = label => {
    const l = lines.find(x => x.toLowerCase().includes(label));
    return l ? l.replace(/^.*?\|\s*/, '').trim() : null;
  };
  const people = lines.filter(l => /^Record \| Customer /.test(l)).map(l => l.replace(/^Record \| Customer /, ''));
  // A "Detail" line holding only a person-like name (two capitalised words) right after a reference.
  for (const l of lines) {
    const m = /^Detail \| ([A-Z][a-zà-ÿ'-]+(?: [A-Z][a-zà-ÿ'-]+)+)$/.exec(l);
    if (m) people.push(m[1]);
  }
  const identifiers = {
    full_name: uniq(people)[0] || null,
    email: find(EMAIL_RE)[0] || null,
    phone: find(PHONE_RE)[0] || null,
    customer_reference: find(USER_RE).length === 1 ? find(USER_RE)[0] : null,
  };

  // Resources named directly, else via a catalog label such as "export_1842 (NST-2026-0718-1842)".
  let ids = find(RESOURCE_RE);
  if (!ids.length) {
    for (const a of catalog) {
      // Only document-style labels (e.g. NST-2026-0718-1842) identify a document; a bare user id does not.
      const label = (/\(([^)]+)\)/.exec(a.details) || [])[1];
      if (label && label !== a.resource_id && !/^user_\d+$/.test(label) && text.includes(label)) ids.push(a.resource_id);
    }
  }
  const records = [];
  for (const rid of uniq(ids)) {
    const r = { resource_id: rid, system_id: systemFor(rid), observed_at: meta.captured_at, present: true, ...identifiers };
    if (rid.startsWith('support_') && /\bfile\b|attachment/i.test(text)) {
      r.collection = 'ticket_attachments';
      r.file_name = (/file (\S+\.pdf)/.exec(text) || [])[1] || null;
    } else if (rid.startsWith('audit_record_')) {
      r.collection = 'security_audit_events';
      r.subject_reference = (/subject reference (user_\d+)/.exec(text) || [])[1] || identifiers.customer_reference;
      r.retained_until = isoDate((lines.find(l => /^retain until/.test(l)) || '').replace(/^retain until /, ''));
      r.event = (lines.find(l => /^Detail \| event /.test(l)) || '').replace(/^Detail \| event /, '') || null;
      delete r.full_name; delete r.email; delete r.phone;
    } else if (rid.startsWith('export_')) {
      r.collection = 'customer_export_jobs';
      r.statement = (/Statement (\S+)/.exec(text) || [])[1] || null;
    }
    records.push(r);
  }
  // Rows of a register that name no resource are kept as context only.
  const unlinked_rows = lines.filter(l => /^\d+ \| ORD-/.test(l));
  return { file_id: meta.file_id, method: 'pdf_text', source: meta.file_path, captured_at: meta.captured_at, records, unlinked_rows, text_lines: lines };
}

// ---------------------------------------------------------------- images (one vision call each)
const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['screen', 'records'],
  properties: {
    screen: { type: 'string', description: 'Which internal tool / page this screenshot shows.' },
    records: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['resource_id', 'record_kind', 'present', 'flow_or_restore', 'status_text', 'names', 'emails', 'phones', 'user_ids', 'email_hashes', 'other_references'],
        properties: {
          resource_id: { type: 'string', description: 'Exact internal id as printed, e.g. account_5762, support_9538, data_flow_1121, backup_9287, audit_record_003, tombstone_17, marketing_001, object_19, export_1260. Empty string if none is printed.' },
          record_kind: { type: 'string', enum: ['customer_profile', 'search_entry', 'analytics_profile', 'marketing_profile', 'support_message', 'support_attachment', 'export_file', 'data_flow', 'backup_archive', 'security_audit_record', 'legal_hold', 'account_tombstone', 'stored_file', 'other'] },
          present: { type: 'boolean', description: 'True if the screen shows this record as existing / available; false if it shows it as deleted, not found, or removed.' },
          flow_or_restore: { type: 'string', enum: ['enabled', 'disabled', 'restorable', 'blocked', 'not_applicable'], description: 'For connectors/data flows: enabled or disabled. For backups: restorable or blocked. Otherwise not_applicable.' },
          status_text: { type: 'string', description: 'Status label(s) exactly as shown, e.g. "Active", "Retained reference", "Restore allowed".' },
          names: { type: 'array', items: { type: 'string' }, description: 'Person names shown for this record.' },
          emails: { type: 'array', items: { type: 'string' } },
          phones: { type: 'array', items: { type: 'string' } },
          user_ids: { type: 'array', items: { type: 'string' }, description: 'Values like user_11.' },
          email_hashes: { type: 'array', items: { type: 'string' }, description: '64-hex-character hashes shown.' },
          other_references: { type: 'array', items: { type: 'string' }, description: 'Other ids shown with this record: ticket CS-…, order ORD-…, file names, archive keys, timestamps.' },
        },
      },
    },
  },
};

const IMAGE_PROMPT = `This is a screenshot of an internal Northstar Shop business tool, captured as evidence for a personal-data deletion audit.
Transcribe the facts it shows about each distinct record (account, support ticket, attachment/file, data flow/connector, backup, analytics or marketing profile, audit record, customer reference, export).
Copy ids, emails, phone numbers and names exactly as printed. Do not infer values that are not visible. Use one entry per resource id; if a record shows no internal id, use an empty resource_id.`;

async function imageFacts(meta, ai) {
  const file = path.join(DATASET, meta.file_path);
  const data = fs.readFileSync(file).toString('base64');
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/png', data } },
        { text: IMAGE_PROMPT },
      ],
    }],
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: IMAGE_SCHEMA,
      maxOutputTokens: 16000,
    },
  });
  const u = response.usageMetadata || {};
  const finish = (response.candidates && response.candidates[0] && response.candidates[0].finishReason) || 'UNKNOWN';
  const usage = {
    at: new Date().toISOString(), file_id: meta.file_id, provider: 'google', model: response.modelVersion || MODEL,
    input_tokens: u.promptTokenCount || 0,
    // Thinking tokens are billed as output.
    output_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
    thinking_tokens: u.thoughtsTokenCount || 0,
    cache_read_input_tokens: u.cachedContentTokenCount || 0, cache_creation_input_tokens: 0,
    stop_reason: finish,
  };
  fs.appendFileSync(USAGE, JSON.stringify(usage) + '\n');
  if (finish !== 'STOP') throw new Error(`${meta.file_id}: generation ended with ${finish}`);
  const parsed = JSON.parse(response.text);
  return { file_id: meta.file_id, method: 'vision', model: usage.model, source: meta.file_path, captured_at: meta.captured_at, screen: parsed.screen, raw: parsed };
}

// Turn the model's transcription into pipeline records. Screens often show a label rather than an
// internal id (a customer key "user_17", a file name); those are mapped through the data catalog's
// "resource (label)" rows. Anything that is still not a resource id is kept as context only.
function normalizeVision(facts, catalog) {
  const STATE = { enabled: { enabled: true }, disabled: { enabled: false }, restorable: { restore_allowed: true }, blocked: { restore_allowed: false } };
  const COLLECTION = { support_attachment: 'ticket_attachments', stored_file: 'ticket_attachments', support_message: 'support_conversations', marketing_profile: 'marketing_profiles', account_tombstone: 'deleted_customer_references' };
  const byLabel = new Map();
  for (const a of catalog) {
    const label = (/\(([^)]+)\)/.exec(a.details) || [])[1];
    if (label && label !== a.resource_id) byLabel.set(label, a.resource_id);
  }
  const isId = s => new RegExp(`^${RESOURCE_RE.source}$`).test(s);
  const records = [], unlinked = [];
  for (const r of facts.raw.records) {
    let rid = r.resource_id;
    if (!isId(rid)) rid = [rid, ...r.other_references].map(x => byLabel.get(x)).find(Boolean) || null;
    if (!rid) { unlinked.push(r); continue; }
    records.push({
      resource_id: rid,
      system_id: systemFor(rid),
      collection: COLLECTION[r.record_kind] || r.record_kind,
      observed_at: facts.captured_at,
      present: r.present,
      status_text: r.status_text,
      shown_as: rid === r.resource_id ? undefined : r.resource_id,
      full_name: r.names[0] || null,
      email: r.emails[0] || null,
      phone: r.phones[0] || null,
      email_hash: r.email_hashes[0] || null,
      customer_reference: r.user_ids[0] || null,
      other_references: r.other_references,
      ...(STATE[r.flow_or_restore] || {}),
    });
  }
  return { ...facts, records, unlinked };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  fs.mkdirSync(CACHE, { recursive: true });
  const manifest = readCsv(path.join(DATASET, 'evidence_files.csv')).rows;
  const catalog = readCsv(path.join(DATASET, 'system_activity.csv')).rows.filter(a => a.event_type === 'LINK_RESOURCE_IDENTITY');
  let client = null;
  const summary = { cached: 0, pdf: 0, image: 0, skipped: [] };
  for (const meta of manifest) {
    const ext = path.extname(meta.file_path).toLowerCase();
    if (ext !== '.pdf' && ext !== '.png') continue;
    const out = path.join(CACHE, `${meta.file_id}.json`);
    if (fs.existsSync(out) && !args.has('--force')) {
      // Re-derive records from the cached model output (no API call) so mapping fixes apply.
      const cached = JSON.parse(fs.readFileSync(out, 'utf8'));
      if (cached.method === 'vision' && args.has('--renormalize')) {
        const facts = normalizeVision(cached, catalog);
        fs.writeFileSync(out, JSON.stringify(facts, null, 2) + '\n', 'utf8');
        console.error(`${meta.file_id}: renormalized, ${facts.records.length} record(s) -> ${facts.records.map(r => r.resource_id).join(', ') || 'none'}; ${facts.unlinked.length} unlinked`);
      }
      summary.cached++;
      continue;
    }
    let facts;
    if (ext === '.pdf') {
      facts = pdfFacts(meta, await pdfLines(path.join(DATASET, meta.file_path)), catalog);
      summary.pdf++;
    } else {
      if (args.has('--pdf-only')) { summary.skipped.push(meta.file_id); continue; }
      if (!client) {
        if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set: copy .env.example to .env and add your key');
        const { GoogleGenAI } = require('@google/genai');
        client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      }
      facts = normalizeVision(await imageFacts(meta, client), catalog);
      summary.image++;
    }
    fs.writeFileSync(out, JSON.stringify(facts, null, 2) + '\n', 'utf8');
    console.error(`${meta.file_id}: ${facts.method}, ${facts.records.length} record(s) -> ${facts.records.map(r => r.resource_id).join(', ') || 'none'}`);
  }
  console.error(`done: ${JSON.stringify(summary)}`);
}

main().catch(err => { console.error(err.message || err); process.exitCode = 1; });

module.exports = { pdfFacts, IMAGE_SCHEMA, MODEL };
