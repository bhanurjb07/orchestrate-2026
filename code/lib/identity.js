'use strict';
// Identity index: every current and historical identifier -> user_id, plus token extraction.
const crypto = require('crypto');

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = s => String(s).trim().toLowerCase();
const normPhone = s => String(s).replace(/\D/g, '');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const USER_RE = /\buser_\d+\b/g;
const HASH_RE = /\b[0-9a-fA-F]{64}\b/g;
const PHONE_RE = /\+\d[\d\s().-]{6,}\d/g;

// Collect identifier tokens from any value (recursing into objects/arrays).
function tokensOf(value, acc = new Set()) {
  if (value == null) return acc;
  if (Array.isArray(value)) { value.forEach(v => tokensOf(v, acc)); return acc; }
  if (typeof value === 'object') { Object.values(value).forEach(v => tokensOf(v, acc)); return acc; }
  const s = String(value);
  for (const m of s.match(EMAIL_RE) || []) acc.add('e:' + normEmail(m));
  for (const m of s.match(USER_RE) || []) acc.add('u:' + m);
  for (const m of s.match(HASH_RE) || []) acc.add('h:' + m.toLowerCase());
  for (const m of s.match(PHONE_RE) || []) { const d = normPhone(m); if (d.length >= 8) acc.add('p:' + d); }
  return acc;
}

class IdentityIndex {
  constructor(identities, auditLog) {
    this.users = new Map();      // user_id -> { user_id, name, emails:Set, phones:Set, hashes:Set, emailHistory:[] }
    this.byToken = new Map();    // token -> Set(user_id)
    for (const r of identities) {
      const u = this.user(r.user_id);
      u.name = r.name;
      this.addEmail(u, r.email);
      this.addPhone(u, r.phone);
      if (r.email_hash) this.add(u, 'h:' + r.email_hash.toLowerCase(), u.hashes);
    }
    for (const a of auditLog) {
      const u = this.user(a.user_id);
      for (const v of [a.old_value, a.new_value]) {
        if (!v) continue;
        if (a.field_name === 'email') this.addEmail(u, v);
        else if (a.field_name === 'phone') this.addPhone(u, v);
      }
      if (a.field_name === 'email') u.emailHistory.push(a);
      u.auditIds.push(a.audit_id);
    }
    for (const u of this.users.values()) this.add(u, 'u:' + u.user_id, null);
  }

  user(id) {
    if (!this.users.has(id)) {
      this.users.set(id, { user_id: id, name: '', emails: new Set(), phones: new Set(), hashes: new Set(), emailHistory: [], auditIds: [] });
    }
    return this.users.get(id);
  }

  add(u, token, set) {
    if (set) set.add(token);
    if (!this.byToken.has(token)) this.byToken.set(token, new Set());
    this.byToken.get(token).add(u.user_id);
  }

  addEmail(u, email) {
    if (!email) return;
    const e = normEmail(email);
    this.add(u, 'e:' + e, u.emails);
    this.add(u, 'h:' + sha256(e), u.hashes);
  }

  addPhone(u, phone) {
    const d = normPhone(phone || '');
    if (d.length >= 8) this.add(u, 'p:' + d, u.phones);
  }

  // The user a request email refers to. Prefer whoever held the address at request time.
  resolveEmail(email, at) {
    const ids = [...(this.byToken.get('e:' + normEmail(email)) || [])];
    if (ids.length <= 1) return ids[0] || null;
    const holders = ids.filter(id => {
      const u = this.users.get(id);
      const changes = u.emailHistory.filter(a => a.event_time <= at).sort((a, b) => (a.event_time < b.event_time ? -1 : 1));
      return changes.length ? normEmail(changes[changes.length - 1].new_value) === normEmail(email) : true;
    });
    return (holders[0] || ids[0]);
  }

  tokensFor(userId) {
    const u = this.users.get(userId);
    return new Set(['u:' + userId, ...u.emails, ...u.phones, ...u.hashes]);
  }
}

module.exports = { IdentityIndex, tokensOf, sha256, normEmail };
