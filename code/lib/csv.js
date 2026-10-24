'use strict';
// Minimal RFC-4180 CSV reader/writer (quoted fields, embedded commas, quotes, newlines).
const fs = require('fs');

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

function readCsv(path) {
  const [header, ...rows] = parseCsv(fs.readFileSync(path, 'utf8'));
  return {
    header,
    rows: rows.map(r => Object.fromEntries(header.map((h, j) => [h, r[j] ?? '']))),
  };
}

function quote(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function writeCsv(path, header, rows) {
  const lines = [header.join(',')].concat(rows.map(r => header.map(h => quote(r[h])).join(',')));
  fs.writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}

module.exports = { parseCsv, readCsv, writeCsv };
