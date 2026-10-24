# Evaluation report — Ghost Data Still Exists

All numbers below come from running the code in this repository:

```bash
npm run samples && npm run score     # 32 public samples vs dataset/sample_output.csv
npm run custom                       # 6 custom cases (code/evaluation/custom_cases.json)
npm start                            # all 518 evaluation requests -> output.csv
```

The scorer (`code/evaluation/main.js`) uses the same output-contract validator as the pipeline (`code/lib/contract.js`).

## 1. Metric definitions

| Metric | Definition |
|---|---|
| Case-level status accuracy | share of cases whose `deletion_status` matches |
| Step precision / recall / F1 | steps matched as whole tuples `(phase, system_id, resource_id, operation, state, evidence_id)` |
| Resource P / R / F1 | the same, ignoring `evidence_id` (did we find the right records and treatments?) |
| Field accuracy | gold steps aligned to predicted steps by `(system_id, resource_id, operation)`; share of `phase`, `state` and `evidence_id` fields that agree. A gold step with no predicted counterpart counts as wrong in every field. |
| Sequence accuracy | the whole `steps_json` array is identical, order included, and the status matches |
| Contract errors | rows that break the output rules (fields, step numbering, operation↔phase/state, evidence rules, canonical order) |

## 2. Results on the 32 public samples (final version)

| Metric | Value |
|---|---:|
| **Case-level status accuracy** | **100.0 %** (32 / 32: 10 COMPLETE, 22 INCOMPLETE) |
| Step precision | 100.0 % (179 of 179 predicted steps are correct) |
| Step recall | 92.7 % (179 of 193 gold steps) |
| Step F1 | 96.2 % |
| Resource P / R / F1 | 100.0 % / 92.7 % / 96.2 % |
| Field accuracy — `phase` | 92.7 % |
| Field accuracy — `state` | 92.7 % |
| Field accuracy — `evidence_id` | 92.7 % |
| **Sequence accuracy** | **62.5 %** (20 / 32 cases exactly right) |
| Contract errors | 0 |

By phase: **every FINDING and REMEDIATION step is reproduced exactly** (findings, the evidence each cites, the remediation operation, and the order). All 14 missed steps are VERIFICATION steps. Field accuracy equals recall because every predicted step that aligns with a gold step is correct in all three fields; only the missing steps count against it.

### The 14 missed steps, by cause

| Cause | Missed steps | Why it is not recovered |
|---|---|---|
| Anonymized analytics record with no identifiers, in a workflow window shared with other cases | 7 (cases 03, 04, 21, 25, 26, 27, 28) | The record carries no email, phone, hash or user id. The only link is the deletion worker's activity, and several requests share the same window, so it is ambiguous. We leave these out rather than guess. |
| Account linked only by worker activity, in a shared window | 5 (accounts 004, 008, 410, 5482, 7012) | Same reason: more than one request remains a candidate after elimination. |
| Audit record that appears in no participant-visible data | 2 (`audit_record_6645`, `audit_record_5569`) | They are absent from every evidence file, activity row and image, so they cannot be found. |

## 3. Custom evaluation cases

Six cases in `code/evaluation/custom_cases.json`. Each **replays a public sample with one input changed**, and its expected answer is derived by hand from the sample's gold answer and the evidence (never from pipeline output). A `replay_of` column makes the pipeline treat the row as a variant of the original request, so it does not compete with it in workflow-window linking.

| Case | Replays | Change | What it tests | Expected |
|---|---|---|---|---|
| custom_01 | case_27 | `audit_at` → 2026-09-18 | Time cutoff from the other side: account_3866 reappears ACTIVE in the 09-17 bundle (evidence_02), which is citable at 09-18 | INCOMPLETE: remaining account_3866 (evidence_02) plus gold's other checks |
| custom_02 | case_29 | email → `noah.f4380@outlook.com` | Identity resolution from the *current* email (the sample uses the historical one; audit_284) | = gold case_29 |
| custom_03 | case_05 | email → `LEILA.HADDAD@YAHOO.COM` | Case-insensitive identifier matching | = gold case_05 |
| custom_04 | case_01 | German request text | Classification in a language absent from all 550 requests | = gold case_01 |
| custom_05 | case_24 | access request ("send me a copy… keep using my account") | Non-deletion request for a subject whose data is still present | NOT_APPLICABLE, `[]` |
| custom_06 | case_09 | `audit_at` → 2026-09-07T10:00 | Early cutoff: the snapshot gold cites (evidence_93, 09-16) does not exist yet; only activity_3709 proves the restore risk | INCOMPLETE: restore risk cited to activity_3709 |

### Results

| Metric | First run | After fixes |
|---|---:|---:|
| Status accuracy | 83.3 % | **100.0 %** |
| Step P / R / F1 | 80.6 % / 93.5 % / 86.6 % | **100.0 % / 93.5 % / 96.7 %** |
| Sequence accuracy | 50.0 % | **66.7 %** (4 / 6) |

- **Passed exactly:** custom_03, 04, 05, 06. custom_06 confirms that no evidence captured after `audit_at` is cited, and that activity facts are used when they are the only proof.
- **custom_01:** the reappearance is detected and cited correctly. It misses only `analytics_4574` (the identifier-free limitation from §2).
- **custom_02:** resolves the subject from the new email and matches case_29 except `account_7012`. That is the same shared-window miss as in the sample itself.

## 4. Failures found and improvements made

Each change was measured with the scorer. Values are on the 32 samples unless marked.

| # | Failure found | How it was found | Improvement | Effect |
|---|---|---|---|---|
| 1 | Scorer reported 25 % sequence accuracy for the gold file itself | Scorer self-test (gold vs gold) | Compare step tuples instead of JSON strings, so key order no longer matters | Gold scores 100 %. A deliberately broken copy is caught on every injected error. |
| 2 | First pipeline: step F1 89.4 %, recall 83.4 % | First sample run | — | Baseline |
| 3 | A later snapshot that merely *omitted* a record was cited ahead of an explicit 404 (cases 26/27); absence-by-omission also wiped out retained audit records | Per-case diff | An explicit observation always wins; omission is used only for DELETE-category records with no explicit observation; retained records get `VERIFY_RECORD_PRESENT` unless shown gone | F1 89.4 → 91.7 % |
| 4 | Accounts with no identifiers (only a 404 lookup) were unlinked | Per-case diff | **Workflow-window linking**: the worker's account delete lands ~1.3 h before `reported_at` and its result mirrors the claimed status. Plus **elimination** of requests whose subject already has its own identified resource in the window | F1 91.7 → 94.6 → 94.9 % |
| 5 | Activity timing alone could not separate cases 27/28 (tested: 17/54 correct for nearest-delete, 1/54 for request window) | Dedicated test before use | Timing is used only together with uniqueness and elimination; the remaining ambiguous resources are left out | No false links: precision 99.4 → 100 % |
| 6 | Full run did not finish in 2 minutes | Timing the 518-case run | Cached window candidates and per-request resource sets | ~1 s for all 518 cases |
| 7 | PDFs unreadable (font-encoded text); case_07 wrong status | Status confusion | Decoded with `pdfjs-dist`, parsed with rules (no tokens) | **Status 96.9 → 100 %**, F1 → 96.2 % |
| 8 | PDF parser linked the legal register to `tombstone_17` through catalog label `(user_17)` | Inspecting extracted facts | Bare user ids are not accepted as document labels; register rows stay as unlinked context (no invented `legal_hold_*` ids) | Removed a false resource |
| 9 | Vision output used screen labels (`user_17`, a file name) as resource ids | Inspecting extracted facts against the screenshots | Labels are mapped through the data catalog (`user_17` → `tombstone_17`, `delivery_confirmation_19.pdf` → `object_19`) from the cached model output, with no new API calls | Eval cases 45/61/63 went from COMPLETE with **no steps** to evidence-backed answers |
| 10 | Image facts from February/March screenshots leaked into September cases (`object_19` → case_07, `tombstone_17` → case_17): precision 100 → 97.8 % | Sample re-score after image extraction | **Multi-request subjects**: a resource seen only up to an earlier request's audit belongs to that request; one first seen after this audit belongs to the later request | Precision back to 100 %; also fixes eval cases 46 and 52 |
| 11 | Unpriced model in the usage report (`gemini-3.1-flash-lite` silently priced as another model) | Reading the usage ledger | Added its published price; an unknown model is now an error instead of a guess | Correct cost in `usage_report.md` |
| 12 | **custom_05: an access request was treated as a deletion** (unclear text defaulted to "deletion") | Custom cases | Unclear text is now NOT_APPLICABLE; added access/copy negations and German deletion vocabulary | Custom status 83.3 → 100 %. Samples and the 518-case output are unchanged (all 550 real requests are still classified by rule) |

### Progression on the samples

| Version | Status | Step P / R / F1 | Field acc. | Sequence |
|---|---:|---:|---:|---:|
| v0 first pipeline | 96.9 % | 96.4 / 83.4 / 89.4 % | 84.5 % | 40.6 % |
| + evidence preference, retained records, workflow linking | 96.9 % | 98.8 / 85.5 / 91.7 % | 85.8 % | 37.5 % |
| + omission limited to DELETE records, account elimination | 96.9 % | 98.9 / 90.7 / 94.6 % | 91.0 % | 56.3 % |
| + elimination for every resource type, one-account rule | 96.9 % | 99.4 / 90.7 / 94.9 % | 91.0 % | 59.4 % |
| + PDF facts | 100 % | 100 / 92.7 / 96.2 % | 92.7 % | 62.5 % |
| + image facts (before multi-request rule) | 100 % | 97.8 / 92.7 / 95.2 % | 92.7 % | 56.3 % |
| **+ multi-request rule (final)** | **100 %** | **100 / 92.7 / 96.2 %** | **92.7 %** | **62.5 %** |

## 5. Full evaluation run (518 requests)

`output.csv`: 518 rows sorted by `case_id`, **0 contract errors**: 153 COMPLETE, 355 INCOMPLETE, 10 NOT_APPLICABLE. The count of NOT_APPLICABLE rows (10) matches the 10 non-deletion classifications in the dataset's privacy-intake activity (`CLASSIFY_REQUEST`). That count is used as a consistency check, never as an input. Every COMPLETE row has at least one evidence-backed verification step. Token usage for this run is in `usage_report.md`.

## 6. Known limitations

- Identifier-free records in shared workflow windows are left out (§2). This is the largest source of lost recall, and it only affects verification steps.
- Image facts depend on one vision pass per screenshot. The 11 results were checked by hand against three screenshots (evidence_37, 46, 60) and matched.
- Request classification is rule-based. It covers all 550 dataset requests and the custom German case. Wording the rules don't recognize is treated as NOT_APPLICABLE (safe default) and logged as a warning.
