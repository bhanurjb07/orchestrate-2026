# Ghost Data Still Exists — deletion-audit agent

HackerRank Orchestrate, October 2026. For every request in `dataset/deletion_requests.csv`, the agent:

1. decides whether the request really asks for deletion;
2. resolves the person's current and historical identifiers;
3. reconstructs each linked record's state at `audit_at` from the evidence; and
4. applies `deletion_rules.csv` to write `output.csv` (`case_id,deletion_status,steps_json`).

The audit is deterministic Node.js code. A language model is used **once per screenshot** (11 images) to read facts from the screen. The results are cached, so producing `output.csv` makes **no model calls**.

The full challenge contract is in [`problem_statement.md`](./problem_statement.md).

---

## 1. Requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | **22.13 or newer** (developed on 24.15) | Uses the built-in `node:sqlite` module to run the `.sql` evidence |
| npm | 10+ | Comes with Node |
| Gemini API key | optional | Only needed to **re-extract** the screenshots; the extracted facts are already in `code/cache/extracted/` |

No Python, no database server, no global packages.

## 2. Setup

From the repository root (the folder that contains `package.json`, `code/` and `dataset/`):

```bash
npm ci
```

This installs the three pinned dependencies from `package-lock.json`: `pdfjs-dist` (PDF text), `@google/genai` (Gemini vision) and `dotenv` (`.env` loading). Use `npm install` if you have no lockfile.

### `.env` (only for image extraction)

API keys are read from environment variables, loaded from a git-ignored `.env` file at the repository root. Never commit `.env` and never put a key in code.

```bash
cp .env.example .env
```

Then edit `.env`:

```dotenv
GEMINI_API_KEY=your-key-here          # from https://aistudio.google.com/apikey
GEMINI_MODEL=gemini-3.1-flash-lite    # optional; default gemini-2.5-flash
```

On Windows PowerShell use `Copy-Item .env.example .env` instead of `cp`. The model must be listed in `code/lib/pricing.js`; otherwise the usage report stops with an error instead of guessing a cost.

## 3. Run

| Command | What it does | Model calls |
|---|---|---|
| `npm start` | Audits all 518 requests → **`output.csv`** at the repo root; records run stats for the usage report | 0 |
| `npm run samples` | Audits the 32 public samples → `sample_pred.csv` | 0 |
| `npm run score` | Scores `sample_pred.csv` against `dataset/sample_output.csv` (`-- --verbose` lists every missing or extra step) | 0 |
| `npm run custom` | Runs the 6 custom evaluation cases in `code/evaluation/custom_cases.json` and scores them | 0 |
| `npm run extract` | Extracts facts from evidence the pipeline cannot read as text: PDFs locally, images via Gemini. Files that already have a cache entry are skipped | 1 per uncached image |
| `npm run usage` | Writes `code/evaluation/usage_report.md` from the extraction ledger and the last `npm start` run | 0 |

Typical sequence from a fresh checkout:

```bash
npm ci
npm start
npm run samples
npm run score
npm run custom
npm run usage
```

To re-extract the screenshots yourself (spends tokens, needs `.env`):

```bash
node --no-warnings code/extract/run.js --force
```

Other extractor flags: `--pdf-only` (no API calls) and `--renormalize`, which rebuilds image records from the cached model output, again with no API calls.

Debug one case (prints linked resources, how each was linked, and its state at `audit_at`):

```bash
node --no-warnings code/main.js --trace case_05
```

Run any requests file:

```bash
node --no-warnings code/main.js --input path/to/requests.csv --output path/to/out.csv
```

## 4. How it works

```
code/
├── main.js                 entry point: classify -> audit -> validate -> output.csv
├── lib/
│   ├── loaders.js          every evidence format -> flat "observations" (with their own timestamps)
│   ├── identity.js         current + historical emails/phones, sha256 email hashes, user ids
│   ├── classify.js         deletion vs not (multilingual rules; unclear text -> NOT_APPLICABLE)
│   ├── audit.js            linking, state at audit_at, deletion rules -> steps
│   ├── contract.js         operation table, canonical ordering, output validator
│   ├── csv.js / pricing.js
├── extract/
│   ├── run.js              one-time extraction: PDFs (pdfjs + rules), images (Gemini vision)
│   └── pdfText.js
├── cache/
│   ├── extracted/          cached facts per image/PDF (<file_id>.json)
│   ├── usage.jsonl         one line per model call (tokens)
│   └── last_run.json       stats of the run that produced output.csv
├── evaluation/
│   ├── main.js             sample scorer
│   ├── custom.js + custom_cases.json   custom evaluation cases
│   ├── usage.js            usage report generator
│   ├── evaluation_report.md
│   └── usage_report.md
└── NOTES.md                investigation notes and design decisions
```

- **Evidence loading.** SQL snapshots are executed in an in-memory SQLite database (primary and replica tables kept apart, so replication drift is visible). JSON bundles keep each inner snapshot's own capture time. Seven log line formats are parsed, and lines sharing a `trace_id` are joined, so a lookup by email connects to the resource it returned. PDFs are decoded with `pdfjs-dist`. Screenshots are read once by Gemini, using a strict JSON schema.
- **Identity.** All current and historical emails and phones, `sha256(lowercase email)` for every email, and the `user_id`. Matching is exact and case-insensitive, so near-duplicate decoy emails never match.
- **Linking.** A resource belongs to the subject if any of its records contains one of the subject's identifiers, a data-catalog row links it, or a linked record references it. Identifier-free records are linked through the deletion workflow's activity only when exactly one request remains a candidate after elimination. When a subject filed several requests, each resource is assigned to the request whose audit window it falls in.
- **State at `audit_at`.** The latest observation at or before `audit_at`, from a file captured at or before `audit_at`. Workflow results (SUCCESS/FAILED) are treated as claims, never as proof.
- **Rules → steps.** Delete / redact / anonymize / retain / tombstone per `deletion_rules.csv`; active data flows and restorable backups are findings. Steps are ordered by phase, then operation, then `system_id`, then `resource_id`. COMPLETE cases cite evidence for every check; the remediation and verification steps of an INCOMPLETE case have an empty `evidence_id`.

## 5. Evaluation

See [`code/evaluation/evaluation_report.md`](code/evaluation/evaluation_report.md) and [`code/evaluation/usage_report.md`](code/evaluation/usage_report.md). On the 32 public samples: **100 % status accuracy**, step precision 100 %, recall 92.7 %, F1 96.2 %, sequence accuracy 62.5 %. The full run writes 518 valid rows with no contract errors.

## 6. Packaging `code.zip`

Include the dependency manifest and `.env.example` so a fresh checkout can install and run. Leave out `dataset/`, `node_modules/` and `.env`.

macOS / Linux:

```bash
zip -r code.zip README.md package.json package-lock.json .env.example code -x "*/node_modules/*" "*/.git/*" "*/.DS_Store" "code/evaluation/custom_run/*"
```

Windows (PowerShell):

```powershell
Compress-Archive -Path README.md, package.json, package-lock.json, .env.example, code -DestinationPath code.zip -Force
```

Submit `code.zip`, the root `output.csv`, and the root `log.txt` (the chat transcript written by the coding agent per [`AGENTS.md`](./AGENTS.md)) at:

https://www.hackerrank.com/contests/hackerrank-orchestrate-october26/challenges/ghost-data-still-exists

Before submitting, check that `output.csv` has 518 rows sorted by `case_id`, and that no API key appears in `code.zip`, `log.txt` or any committed file.
