# Token usage and cost

Run that produced `output.csv`: 2026-10-24T22:55:08.343Z — 518 requests (INCOMPLETE 355, COMPLETE 153, NOT_APPLICABLE 10).

## How the model is used

- The audit pipeline (`code/main.js`) is deterministic code and makes **0 model calls** per run.
- The only model calls are one-time **vision extractions**: one call per screenshot (11 images), made by `code/extract/run.js`. The facts are cached in `code/cache/extracted/` and reused on every run, so the per-run model cost is the cost of that one-time extraction.
- The 4 PDFs are decoded locally with `pdfjs-dist` and parsed with rules, so they use no tokens.
- Request classification is rule-based and uses no tokens. All 518 requests matched a deletion or non-deletion rule, so none was left unclear.

## Per model

| Provider | Model | Calls | Input tokens | Output tokens | Cache tokens | Total tokens | Est. cost |
|---|---|---:|---:|---:|---:|---:|---:|
| google | `gemini-3.1-flash-lite` | 11 | 13,105 | 5,935 | 0 | 19,040 | $0.0122 |
| **Overall** | | **11** | **13,105** | **5,935** | **0** | **19,040** | **$0.0122** |

## Per request (518 requests in the final run)

| Metric | Value |
|---|---:|
| Model calls per request | 0.0212 |
| Average tokens per request | 36.8 |
| Estimated cost per request | $0.0000 |
| Estimated total cost | $0.0122 |

## Per image

| File | Model | Input tokens | Output tokens | Est. cost | Stop reason |
|---|---|---:|---:|---:|---|
| evidence_04 | `gemini-3.1-flash-lite` | 1,191 | 358 | $0.0008 | STOP |
| evidence_09 | `gemini-3.1-flash-lite` | 1,203 | 342 | $0.0008 | STOP |
| evidence_14 | `gemini-3.1-flash-lite` | 1,177 | 500 | $0.0010 | STOP |
| evidence_19 | `gemini-3.1-flash-lite` | 1,177 | 227 | $0.0006 | STOP |
| evidence_23 | `gemini-3.1-flash-lite` | 1,203 | 643 | $0.0013 | STOP |
| evidence_28 | `gemini-3.1-flash-lite` | 1,191 | 206 | $0.0006 | STOP |
| evidence_32 | `gemini-3.1-flash-lite` | 1,177 | 761 | $0.0014 | STOP |
| evidence_37 | `gemini-3.1-flash-lite` | 1,203 | 849 | $0.0016 | STOP |
| evidence_42 | `gemini-3.1-flash-lite` | 1,203 | 701 | $0.0014 | STOP |
| evidence_46 | `gemini-3.1-flash-lite` | 1,177 | 1,151 | $0.0020 | STOP |
| evidence_60 | `gemini-3.1-flash-lite` | 1,203 | 197 | $0.0006 | STOP |

Prices used (per million tokens): `gemini-2.5-flash` input $0.3, output $2.5, cache read $0.03, cache write $0; `gemini-2.5-flash-lite` input $0.1, output $0.4, cache read $0.01, cache write $0; `gemini-2.5-pro` input $1.25, output $10, cache read $0.125, cache write $0; `gemini-3-flash-preview` input $0.5, output $3, cache read $0.05, cache write $0; `gemini-3.1-flash-lite` input $0.25, output $1.5, cache read $0.025, cache write $0.
