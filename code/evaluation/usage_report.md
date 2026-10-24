# Token usage and cost

Run that produced `output.csv`: 2026-10-24T22:12:58.064Z — 518 requests (INCOMPLETE 347, COMPLETE 161, NOT_APPLICABLE 10).

## How the model is used

- The audit pipeline (`code/main.js`) is deterministic code and makes **0 model calls** per run.
- The only model calls are one-time **vision extractions**: one call per screenshot (0 images), made by `code/extract/run.js`. The facts are cached in `code/cache/extracted/` and reused on every run, so the per-run model cost is the cost of that one-time extraction.
- The 4 PDFs are decoded locally with `pdfjs-dist` and parsed with rules, so they use no tokens.
- Request classification is rule-based and uses no tokens. All 518 requests matched a deletion or non-deletion rule, so none was left unclear.

## Per model

| Provider | Model | Calls | Input tokens | Output tokens | Cache tokens | Total tokens | Est. cost |
|---|---|---:|---:|---:|---:|---:|---:|
| – | – | 0 | 0 | 0 | 0 | 0 | $0.0000 |
| **Overall** | | **0** | **0** | **0** | **0** | **0** | **$0.0000** |

## Per request (518 requests in the final run)

| Metric | Value |
|---|---:|
| Model calls per request | 0.0000 |
| Average tokens per request | 0.0 |
| Estimated cost per request | $0.0000 |
| Estimated total cost | $0.0000 |

## Per image

| File | Model | Input tokens | Output tokens | Est. cost | Stop reason |
|---|---|---:|---:|---:|---|
| – | – | 0 | 0 | $0.0000 | – |

Prices used (per million tokens): `gemini-2.5-flash` input $0.3, output $2.5, cache read $0.03, cache write $0; `gemini-2.5-flash-lite` input $0.1, output $0.4, cache read $0.01, cache write $0; `gemini-2.5-pro` input $1.25, output $10, cache read $0.125, cache write $0; `gemini-3-flash-preview` input $0.5, output $3, cache read $0.05, cache write $0.
