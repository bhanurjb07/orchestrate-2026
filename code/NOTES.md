# Investigation notes (before coding)

Hand-traced 8 sample cases against `dataset/sample_output.csv`:
**01, 05, 09, 11, 12, 27, 28, 32**. Plus a quick look at the rest of the sample outputs for
ordering patterns. No code written yet.

## 1. What each traced case taught us

| Case | Expected | Key lesson |
|---|---|---|
| 01 | COMPLETE, 1 step | `account_001` is **missing** from both tables of `evidence_54` (failover replica SQL, 09-02 < audit 09-03). Absence in a snapshot that should contain it = proof → `VERIFY_RECORD_ABSENT` citing that file. |
| 05 | INCOMPLETE | Deletion worker said SUCCESS (activity_3482) and the primary table has no `account_005`, but the **failover replica table still has it** → `REPORT_REMAINING_RECORD account_service/account_005` citing `evidence_54`. Replica rows are reported under the logical `system_id` (`account_service`), not the replica name. Decoys with similar names (Karim El-Masri) live in the same file. |
| 09 | INCOMPLETE | `evidence_93` (inventory SQL) has `backup_restore_entries.backup_4978` with `customer_email=k.appiah88@gmail.com, restore_allowed=1` → `REPORT_RESTORE_RISK`. The account (`account_3960`) and audit record (`audit_record_4902`) are found **only** via a log captured *after* audit_at (`evidence_06`), joined by `trace_id`: `profile_lookup_started lookup_key=<email>` → `profile_lookup_completed resource_id=account_3960 rows=0`. These go into future verification (empty evidence), so they need linkage, not citation. Delete activity said FAILED, yet the account counts as absent (no finding). |
| 11 | INCOMPLETE, 14 steps | `evidence_03` (handover .txt) is a clean table: `system | resource | CATEGORY | STATUS | identifier`. Mapping: `SEARCH_INDEX_ENTRY FOUND` → remaining/DELETE; `ANALYTICS_PROFILE IDENTIFIABLE` → exposed PII/ANONYMIZE; `SUPPORT_MESSAGE IDENTIFIABLE` → exposed PII/REDACT; `SUPPORT_ATTACHMENT FOUND` → remaining/DELETE; `DATA_FLOW ACTIVE` → active flow/DISABLE; `BACKUP_ARCHIVE ACTIVE` → restore risk/BLOCK; `SECURITY_AUDIT_LOG FOUND` (keyed by user_id) → VERIFY_PRESENT; `USER_PROFILE NOT_FOUND` → VERIFY_ABSENT. `audit_at == captured_at` here, so the cutoff is **inclusive (≤)**. |
| 12 | INCOMPLETE | Request email is current; the stale record is keyed by the **SHA-256 of the old email** (`minjun.kim90@gmail.com`, from `user_audit_log`). `email_hash = sha256(lowercase email)` — verified. `analytics_9914` is a `contact_lookup` with `email_opt_in=true` (a marketing-style contact), so it gets `REPORT_REMAINING_RECORD` + `DELETE_RECORD`, **not** anonymize, even though system is `analytics_platform`. Category comes from the record's nature, not the system name. |
| 27 | COMPLETE, 6 steps | Time cutoff trap: `evidence_92` (09-15T11:44) shows `account_3866` 404, but the 09-17 bundle has an inner snapshot (captured 09-17) with it ACTIVE again. Audit is 09-15T12:00, so the later one is ignored → COMPLETE. All 6 verifications cite `evidence_92`. |
| 28 | COMPLETE, 6 steps | Decoy: a search document for `smartinez6461.jr@gmail.com` (near-identical email) must **not** be matched. Exact identifier match only. |
| 32 | INCOMPLETE | `evidence_51` bundle `deleted_customer_references`: `tombstone_9178` keeps `subject_reference=user_542` (allowed) but also name/email/phone/hash (not allowed) → `REPORT_EXPOSED_PII` + `REDACT_RECORD` + `VERIFY_RECORD_REDACTED` on `identity_service`. Case 31's `tombstone_440` has all identifiers null → `VERIFY_RECORD_REDACTED` with evidence. |

## 2. Output shape rules (confirmed across all 32 samples)

- Ordering inside each phase = operation order from the problem table, then `system_id`, then `resource_id` (string sort).
  - FINDING: REMAINING_RECORD → EXPOSED_PII → ACTIVE_DATA_FLOW → RESTORE_RISK
  - REMEDIATION: DISABLE_DATA_FLOW → BLOCK_RESTORE → DELETE → REDACT → ANONYMIZE
  - VERIFICATION: ABSENT → PRESENT → REDACTED → ANONYMIZED → FLOW_DISABLED → RESTORE_BLOCKED
- Every finding gets exactly one remediation and one matching verification.
- **The account always appears**: `VERIFY_RECORD_ABSENT account_service/account_X`, even if it was never a finding.
- **The security audit record always appears** (when one exists for the user) as `VERIFY_RECORD_PRESENT security_service/audit_record_X` (rule_12 RETAIN).
- COMPLETE cases: verification-only, each step cites evidence (usually one snapshot file that shows the whole state). Already-compliant resources (anonymized analytics, redacted support, disabled flow, blocked backup, redacted tombstone) are listed as verifications.
- INCOMPLETE cases: findings cite evidence; remediation + verification use `""`. Already-compliant resources still appear in verification (e.g. case_09 audit record).
- No sample is NOT_APPLICABLE, but `system_activity.csv` has 10 `CLASSIFY_REQUEST … non-deletion` events → the eval set has them. Need request-text classification (multilingual: ES, FR, JA seen).

## 3. Evidence sources and how they link to a person

Identity keys per user: `user_id`, current + historical emails (lowercase compare — some evidence is UPPERCASE), phones (current + historical), sha256 of every email, name.

| Source | Format | Link mechanism |
|---|---|---|
| `customer_data_inventory_*.sql` | SQLite text | `customer_reference` (user_id) or email/phone/hash columns; `snapshot_scope` table gives per-system capture time |
| `customer_data_*replica*.sql`, `customer_accounts_failover_*.sql` | SQLite text | user_id column; compare primary vs replica tables for drift |
| `service_resource_export_*.json` | JSON | per-service lists with `customer_reference` / email / `observed_at` |
| `customer_data_snapshot_bundle_*.json` | JSON | list of inner snapshots, **each with its own `captured_at`** — must filter inner snapshots by audit_at, not only the file time |
| `customer_account_handover_*.txt` | pipe table | email or user_id in last column, category + status given directly |
| logs (`*.log`) | key=value or JSON lines | **join by `trace_id`**: a `*_started` line carries `lookup_key`/`subject_key`/`subject_ref`/`match_key`; the `*_completed` line with the same trace carries `resource_id` and result (`rows=0/1`, `enabled`, `eligible`, `direct_identifiers`). Some lines carry `correlation_key` directly. |
| `system_activity.csv` | CSV | deletion_worker actions (claims only); `LINK_RESOURCE_IDENTITY` rows (data_catalog) explicitly link a resource to email + user_id — these back the image/PDF evidence; `CHECK_RESTORE_ACCESS` / `CHECK_DATA_FLOW` state facts; one `RESTORE_BACKUP` that repopulated a search record |
| PNG (11) / PDF (4) | images/docs | business screens (e.g. `user_17` tombstone registry). Small enough to extract once with an LLM / pdf text and cache as JSON |
| `user_audit_log.csv` | CSV | historical email/phone values; also citable `audit_id` |

## 4. Decision logic sketch (to implement)

1. **Classify request_text** → deletion vs not (keyword rules in several languages; LLM fallback for unclear text).
2. **Resolve identity**: email → user_id (current snapshot or audit-log old/new value) → all emails, phones, hashes.
3. **Collect candidate resources** for the user from every source (direct identifier match, user_id match, trace_id joins, catalog links). Linkage may use any evidence (even post-audit) — case_09 needed a post-audit log to find account/audit ids.
4. **State at audit_at**: for each resource, take the latest observation with timestamp ≤ audit_at (inner snapshot `captured_at` / line timestamp / `observed_at`), from files whose `captured_at` ≤ audit_at for citation. Activity results are claims; use them only when no observation exists.
5. **Map to category → rule → required treatment**, compare with observed state → finding or verification.
6. **Emit steps** in canonical order; COMPLETE iff no findings.

## 5. Open questions / risks

- **Evidence choice when several files prove the same thing.** Samples cite one snapshot (often the latest ≤ audit_at covering that system). Need a rule, e.g. "latest citable observation". Case_09 cites `evidence_93` (SQL) not `activity_3709` for the restore risk → prefer file evidence over activity.
- **Anonymized records with no identifiers** (case_27 `analytics_4574` vs case_28 `analytics_6077`): no text evidence links them to a user. Activity timing was tested and **does not work** (see §7). Still to check: images/PDFs and earlier snapshots.
- **Category inference** when system name is misleading (case_12 marketing-style contact in analytics → DELETE). Look for signals like `email_opt_in`, `contact_lookup`, collection names.
- Support message vs attachment (REDACT vs DELETE): handover file states it; elsewhere infer from `message_excerpt`/attachment fields and the `object_storage` catalog line ("belongs only to …").
- Restore re-creation (`RESTORE_BACKUP` activity) and active syncs recreating deleted records — must check for observations *after* a successful delete but ≤ audit_at.
- Python on this machine: use `py -3.12` (the bare `python` alias is the Store stub).

## 6. Gaps in the 5-step plan (agreed)

The outline (classify → resolve identity → search evidence → apply rules → decide) holds. These additions are part of the plan:

1. **Linking is separate from state.** Use *any* evidence to link a resource to the person (case_09 needs a post-audit log). Use only observations at or before `audit_at` for state and citations. Apply the cutoff per inner snapshot `captured_at`, log line timestamp and `observed_at`, not just the file's manifest time (case_27).
2. **Grow a set of linked IDs, don't run a single search.** Start from emails/phones/hashes/user_id, then add resource IDs via `trace_id` joins in logs, `LINK_RESOURCE_IDENTITY` catalog rows, and `customer_reference`/`subject_reference`. Match exactly, case-insensitively. Near-duplicate decoys exist (case_28).
3. **Rebuild the state explicitly** between search and rules. For each resource, take the latest observation ≤ `audit_at`. Deletion-worker results are claims: case_05 said SUCCESS but the record remained, case_09 said FAILED but the account was gone. Check whether a sync or restore brought anything back after a delete.
4. **COMPLETE ≠ "nothing left".** It also needs: retained records present (security audit), tombstones reduced to `user_id`, no active flows, no restorable backups. Already-compliant resources still appear as verification steps (the account always gets ABSENT, the audit record always gets PRESENT).
5. **Category comes from what the record is**, not the system name (case_12: a marketing contact in `analytics_platform` gets DELETE). Needs a record → rule-category mapper (support message vs attachment, analytics vs marketing, …).
6. **Evidence-citation rule** to be pinned down. Working hypothesis: the latest file at or before `audit_at` covering that system; prefer files over activity rows.
7. **NOT_APPLICABLE needs its own tests.** No samples use it, but the eval set does (10 `CLASSIFY_REQUEST … non-deletion` rows). Requests are multilingual. Use keywords, with an LLM fallback for unclear text, plus hand-written test cases.
8. **Score early and track usage.** `code/score.py` (below). Cache and count every LLM call from day one for `usage_report.md`.

## 7. Test: does activity timing link identifier-free records? — No

Script: scratchpad `link_test.py` (throwaway). Checked against the gold owners in `sample_output.csv`.

Cases 27/28 share a single deletion_worker batch (2026-08-30 10:46–11:52). Owners alternate inside it:

```
10:46 account_5482      case_28      11:38:23 support_2351   case_28
10:57 account_3866      case_27      11:38:38 support_4707   case_27
11:06 account_7012      case_29      11:45:08 data_flow_2295 case_27
11:31:09 analytics_4574 case_27      11:45:52 data_flow_2337 case_28
11:31:53 analytics_6077 case_28      11:52:22 backup_838     case_28
                                     11:52:37 backup_5970    case_27
```

- "Nearest preceding account delete" picks `account_7012` (case_29) for **all** of 27/28's resources. Across all samples it scores **17/54**.
- "Unique case whose requested→reported window contains the action" is correct for **1/54**; the other cases are ambiguous because many cases share a window.
- Order within the batch isn't consistent either (account order 28→27, analytics 27→28).

**Conclusion:** activity timing tells us only *which batch* a resource belongs to, never *which person*. Don't use it to link. Options for these records:
(a) leave them out (lose one verification step);
(b) assign by elimination when every other resource in the batch is already linked by identifiers;
(c) look for links in images/PDFs and earlier snapshots first.
In 27/28 elimination can't decide, because both analytics rows have no identifiers. Pick (a) or (b) by measuring with the scorer.

**Follow-up (§10):** a narrower window keyed to `reported_at`, plus elimination, *does* link many identifier-free resources. In 27/28/29, however, the analytics rows stay ambiguous, so they are left out. A quick check of the images, PDFs and older snapshots found nothing linking `analytics_4574`/`analytics_6077`: the PDFs are font-encoded, and every image maps to another user's catalog row.

## 8. Sample scorer — `code/evaluation/main.js` (Node; replaces the earlier Python `score.py`)

```
node code/evaluation/main.js                          # ./output.csv vs dataset/sample_output.csv
node code/evaluation/main.js --pred X.csv --verbose   # per-case missing/extra steps
node code/evaluation/main.js --report evaluation/sample_score.md
```

Reports status accuracy; step P/R/F1 (full tuple); resource P/R/F1 (ignoring evidence); field accuracy (phase/state/evidence on steps aligned by system+resource+operation); sequence accuracy; status confusion. It also checks the contract (shared with the pipeline in `code/lib/contract.js`): valid statuses, exact step fields, consecutive `step_no`, operation↔phase/state pairing, empty evidence on future steps, required evidence otherwise, COMPLETE = verification only, and canonical ordering.

Self-test: gold vs gold = 100% on everything, with no contract errors. A perturbed copy (wrong status, wrong evidence, swapped order, dropped step, missing case) was detected in every case, and the numbers match the Python version exactly. Exit code is 0 only when sequence accuracy is 100%.

## 9. Pipeline v0 (Node, no dependencies; Node ≥ 22 for `node:sqlite`)

```
node --no-warnings code/main.js                                   # 518 cases -> ./output.csv
node --no-warnings code/main.js --input dataset/sample_deletion_requests.csv --output sample_pred.csv
node --no-warnings code/main.js --trace case_05                   # links + state per resource
```

| Module | Role |
|---|---|
| `lib/loaders.js` | SQL (executed with `node:sqlite`), JSON bundles/exports/ledgers, handover txt, 7 log line formats → flat observations with their own `ts`. Log lines are merged by `trace_id`. Image/PDF facts are read from `code/cache/extracted/<file_id>.json` once they exist. |
| `lib/identity.js` | Current + historical emails/phones, sha256 of every email, and `user_id` → token index. Token extraction from any value, free text included. |
| `lib/classify.js` | Deletion vs not. Negations first ("not asking for deletion", "don't delete", "marketing lists only" …), then multilingual deletion verbs. All 518 + 32 requests are decided; none are unclear. |
| `lib/audit.js` | Linking → state at `audit_at` → rules → steps. |
| `lib/contract.js` | Operation table, canonical ordering, validator (used by both pipeline and scorer). |

Key decisions, each one measured with the scorer:
- **State** = the latest observation with `ts ≤ audit_at` from a file captured `≤ audit_at`. When several copies share that time, any copy still present wins (replica drift). Activity is used only for checked facts (`CHECK_RESTORE_ACCESS`, `CHECK_DATA_FLOW`, `RESTORE_BACKUP`), never for the worker's own claims.
- **Absence by omission** (the latest scoped snapshot of the system doesn't list the record) is used **only** for DELETE-category records with no explicit observation (case_01). For retained records it wrongly hid audit records. An explicit 404 is cited before a later omission (cases 26/27).
- **Retained records** (security audit, legal hold) always get `VERIFY_RECORD_PRESENT` unless evidence shows them gone (case_09: its only proof is post-audit).
- **COMPLETE** cases drop verification steps they can't cite (the contract requires evidence).

## 10. Workflow-window linking (identifier-free resources)

The deletion worker acts on a case's resources in a narrow window: the account delete lands ~1.3 h before `reported_at`, follow-ups land up to ~2 h after. The account delete's `reported_result` mirrors the claimed status (COMPLETE→SUCCESS, PARTIALLY_COMPLETE→PARTIAL, NOT_STARTED→FAILED). Many sample and eval cases share the same `reported_at`, so a worker action is linked to a request only when:
- no identifier ties the resource to someone else;
- after elimination, exactly one deletion request (out of all 550) remains in the window. Elimination drops a candidate whose subject already has its own identified resource of the same kind acted on in that window. For accounts, the result must also match the claim.

When the workflow names an account, other already-gone accounts linked only by old lookups are dropped (case_17's `account_6523` from a March lookup). A still-present account is always kept.

## 11. Current score on the 32 samples

```
status accuracy   : 96.9%      step P/R/F1     : 99.4% / 90.7% / 94.9%
field accuracy    : 91.0%      resource P/R/F1 : 100%  / 91.2% / 95.4%
sequence accuracy : 59.4%      full run: 518 valid rows (162 COMPLETE / 346 INCOMPLETE / 10 NOT_APPLICABLE)
```

Remaining misses, by cause:
- **Image/PDF facts not extracted yet** (15 files): case_07 (`support_001` in a PDF) is the only status error. In the eval set, cases 45, 61 and 63 come out COMPLETE with **no steps**, because their only linked resource lives in a screenshot (`audit_record_003`, `object_19`, `marketing_001`). This is the next thing to build: an extraction step that writes `code/cache/extracted/<file_id>.json`, then reuse the same loaders.
- **Identifier-free analytics in shared windows** (7 rows: cases 03, 04, 21, 25, 26, 27, 28): left out, as agreed.
- **Accounts in shared windows** (004, 008, 410, 5482, 7012): left out.
- **Audit records with no participant-visible trace** (`audit_record_6645`, `audit_record_5569`, cases 18/20): they appear in no evidence file, activity row or image. Unrecoverable.

## 12. Image/PDF extraction — `code/extract/run.js`

```
node --no-warnings code/extract/run.js --pdf-only   # PDFs only, no API
node --no-warnings code/extract/run.js              # + images (needs GEMINI_API_KEY in .env)
node code/evaluation/usage.js                       # -> code/evaluation/usage_report.md
```

- **PDFs (4):** decoded locally with `pdfjs-dist@6.4.299` (`code/extract/pdfText.js` rebuilds visual lines). Facts are parsed with rules and use no tokens.
  - evidence_58 → `support_001` attachment containing Priya Raman's name, email and phone (fixes case_07).
  - evidence_55 → `audit_record_003` (user_03, retained until 2027-08-25).
  - evidence_18 → `export_1842`, linked through the catalog label `NST-2026-0718-1842` (activity_4009).
  - evidence_27 (legal register) names orders but no resource IDs, and those orders appear nowhere else. They are kept as `unlinked_rows` context only, never turned into invented `legal_hold_*` IDs. A first version wrongly matched catalog label `(user_17)` → `tombstone_17`; bare user IDs are now excluded as labels.
- **Images (11):** one **Gemini** vision call per image through `@google/genai@2.28.0`. The model is `GEMINI_MODEL` (default `gemini-2.5-flash`), with JSON output constrained by `responseJsonSchema: IMAGE_SCHEMA`. Results are cached in `code/cache/extracted/<file_id>.json` and never re-sent unless `--force` is passed. Each call's `usageMetadata` is appended to `code/cache/usage.jsonl` (prompt tokens; candidate + thinking tokens as output; cached tokens). A non-`STOP` finish reason is treated as an error, so a truncated or blocked answer is never cached. *(This first used Claude; switched to Gemini at the user's request.)*
- **Secrets:** `dotenv@18.0.7` loads the repo-root `.env`, which is git-ignored. `.env.example` lists `GEMINI_API_KEY` and `GEMINI_MODEL` with no values. The key is never logged or written to the cache.
- **Usage report:** `code/main.js` writes `code/cache/last_run.json` when it produces `./output.csv` (the pipeline makes 0 model calls). `usage.js` combines that with the ledger: per-model and overall calls, tokens, and cost per request. Prices are in `code/lib/pricing.js` (Gemini paid tier, checked 2026-10-25; `gemini-2.5-flash` = $0.30 input / $2.50 output per MTok). Versioned model names returned by the API are matched to their base ID.
- **Status:** PDFs are done. Images are **not run**; the user will run `npm run extract` with their own key.

Sample score with PDF facts: **status 100%**, step P/R/F1 **100% / 92.7% / 96.2%**, field 92.7%, sequence 62.5%. Full run: 518 rows (161 COMPLETE / 347 INCOMPLETE / 10 NOT_APPLICABLE). Eval cases 45, 61 and 63 still need the image facts.
