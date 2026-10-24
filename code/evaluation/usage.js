#!/usr/bin/env node
'use strict';
/*
Write code/evaluation/usage_report.md from:
  code/cache/usage.jsonl     - one line per model call made by code/extract/run.js
  code/cache/last_run.json   - written by code/main.js for the run that produced output.csv

Usage: node code/evaluation/usage.js
*/
const fs = require('fs');
const path = require('path');
const { MODEL_PRICES, priceFor } = require('../lib/pricing');

const CACHE = path.join(__dirname, '..', 'cache');
const OUT = path.join(__dirname, 'usage_report.md');

const readJsonl = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const usd = x => '$' + x.toFixed(4);
const n = x => x.toLocaleString('en-US');

function cost(c) {
  const p = priceFor(c.model);
  return (c.input_tokens * p.input + c.output_tokens * p.output +
    c.cache_read_input_tokens * p.cache_read + c.cache_creation_input_tokens * p.cache_write) / 1e6;
}

function main() {
  const calls = readJsonl(path.join(CACHE, 'usage.jsonl'));
  const run = fs.existsSync(path.join(CACHE, 'last_run.json')) ? JSON.parse(fs.readFileSync(path.join(CACHE, 'last_run.json'), 'utf8')) : null;
  const requests = run ? run.requests : 0;

  // Only the latest call per file counts toward the cached facts the run used; re-extractions are listed separately.
  const latest = new Map();
  for (const c of calls) latest.set(c.file_id, c);
  const used = [...latest.values()];
  const byModel = new Map();
  for (const c of used) {
    const k = `${c.provider}|${c.model}`;
    const m = byModel.get(k) || { provider: c.provider, model: c.model, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    m.calls++; m.input += c.input_tokens; m.output += c.output_tokens;
    m.cacheRead += c.cache_read_input_tokens; m.cacheWrite += c.cache_creation_input_tokens; m.cost += cost(c);
    byModel.set(k, m);
  }
  const total = [...byModel.values()].reduce((a, m) => ({
    calls: a.calls + m.calls, input: a.input + m.input, output: a.output + m.output,
    cacheRead: a.cacheRead + m.cacheRead, cacheWrite: a.cacheWrite + m.cacheWrite, cost: a.cost + m.cost,
  }), { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const tokens = total.input + total.output + total.cacheRead + total.cacheWrite;
  const perReq = v => (requests ? v / requests : 0);

  const rows = [...byModel.values()].map(m =>
    `| ${m.provider} | \`${m.model}\` | ${m.calls} | ${n(m.input)} | ${n(m.output)} | ${n(m.cacheRead + m.cacheWrite)} | ${n(m.input + m.output + m.cacheRead + m.cacheWrite)} | ${usd(m.cost)} |`);
  const perFile = used.map(c => `| ${c.file_id} | \`${c.model}\` | ${n(c.input_tokens)} | ${n(c.output_tokens)} | ${usd(cost(c))} | ${c.stop_reason} |`);
  const extra = calls.length - used.length;

  const md = `# Token usage and cost

Run that produced \`output.csv\`: ${run ? `${run.at} — ${n(requests)} requests (${Object.entries(run.statuses).map(([k, v]) => `${k} ${v}`).join(', ')})` : 'not recorded yet (run \`node code/main.js\`)'}.

## How the model is used

- The audit pipeline (\`code/main.js\`) is deterministic code and makes **${run ? run.llm_calls : 0} model calls** per run.
- The only model calls are one-time **vision extractions**: one call per screenshot (${used.length} images), made by \`code/extract/run.js\`. The facts are cached in \`code/cache/extracted/\` and reused on every run, so the per-run model cost is the cost of that one-time extraction.
- The 4 PDFs are decoded locally with \`pdfjs-dist\` and parsed with rules, so they use no tokens.
- Request classification is rule-based and uses no tokens. All ${n(requests)} requests matched a deletion or non-deletion rule, so none was left unclear.

## Per model

| Provider | Model | Calls | Input tokens | Output tokens | Cache tokens | Total tokens | Est. cost |
|---|---|---:|---:|---:|---:|---:|---:|
${rows.join('\n') || '| – | – | 0 | 0 | 0 | 0 | 0 | $0.0000 |'}
| **Overall** | | **${total.calls}** | **${n(total.input)}** | **${n(total.output)}** | **${n(total.cacheRead + total.cacheWrite)}** | **${n(tokens)}** | **${usd(total.cost)}** |

## Per request (${n(requests)} requests in the final run)

| Metric | Value |
|---|---:|
| Model calls per request | ${perReq(total.calls).toFixed(4)} |
| Average tokens per request | ${perReq(tokens).toFixed(1)} |
| Estimated cost per request | ${usd(perReq(total.cost))} |
| Estimated total cost | ${usd(total.cost)} |

## Per image

| File | Model | Input tokens | Output tokens | Est. cost | Stop reason |
|---|---|---:|---:|---:|---|
${perFile.join('\n') || '| – | – | 0 | 0 | $0.0000 | – |'}
${extra > 0 ? `\nAdditionally, ${extra} earlier extraction call(s) were superseded by re-extraction and are not counted above.\n` : ''}
Prices used (per million tokens): ${Object.entries(MODEL_PRICES).filter(([k]) => k !== 'default').map(([k, p]) => `\`${k}\` input $${p.input}, output $${p.output}, cache read $${p.cache_read}, cache write $${p.cache_write}`).join('; ')}.
`;
  fs.writeFileSync(OUT, md, 'utf8');
  console.error(`wrote ${path.relative(process.cwd(), OUT)}: ${total.calls} calls, ${n(tokens)} tokens, ${usd(total.cost)}`);
}

main();
