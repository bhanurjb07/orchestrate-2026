'use strict';
// USD per million tokens, Gemini API paid tier (ai.google.dev/gemini-api/docs/pricing, checked 2026-10-25).
// Output includes thinking tokens. Cache writes are not used (no explicit context caching).
const MODEL_PRICES = {
  'gemini-2.5-flash': { input: 0.30, output: 2.50, cache_read: 0.03, cache_write: 0 },
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40, cache_read: 0.01, cache_write: 0 },
  'gemini-2.5-pro': { input: 1.25, output: 10.00, cache_read: 0.125, cache_write: 0 },   // prompts <= 200k tokens
  'gemini-3-flash-preview': { input: 0.50, output: 3.00, cache_read: 0.05, cache_write: 0 },
};
MODEL_PRICES.default = MODEL_PRICES['gemini-2.5-flash'];

// The API may report a versioned name (e.g. "gemini-2.5-flash-001"); match on the base id.
function priceFor(model) {
  const key = Object.keys(MODEL_PRICES).filter(k => k !== 'default' && String(model).startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return MODEL_PRICES[key] || MODEL_PRICES.default;
}

module.exports = { MODEL_PRICES, priceFor };
