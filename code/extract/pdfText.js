'use strict';
// Decode a PDF's text with pdfjs and rebuild visual lines (items sharing a baseline, left to right).

async function pdfLines(file) {
  const fs = require('fs');
  const path = require('path');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdfjs expects a forward-slash URL-style directory with a trailing slash, even on Windows.
  const fontDir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts').replace(/\\/g, '/') + '/';
  const data = new Uint8Array(fs.readFileSync(file));
  const task = pdfjs.getDocument({ data, standardFontDataUrl: fontDir, useSystemFonts: false, isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    const rows = new Map();
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], s: it.str });
    }
    const lines = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, cells]) => cells.sort((a, b) => a.x - b.x).map(c => c.s.trim()).join(' | '));
    pages.push(lines);
  }
  await task.destroy();
  return pages;
}

module.exports = { pdfLines };
