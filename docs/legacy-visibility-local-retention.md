# Local legacy visibility answer-field transition

This procedure is for an explicitly enrolled disposable PostgreSQL 17 database named `lyraseo_legacy_<12 lowercase hex characters>`. It is not qualified for hosted or customer data. It changes only an eligible legacy `VisibilityRun.rawAnswers` value to SQL NULL; it does not erase a run, other stored fields, exports, providers, database storage history, or backups. Input-derived strings in other fields remain unclassified residuals.

The admin first registers the actual database OID and current postmaster start in the existing local test environment. The purpose role and maintenance login must already exist with the safe definitions checked by migration 28. A trusted admin activates one workspace/site fence and enrolls the frozen current rows. This treats the current row and its persisted `rawExpiresAt` as the `LEGACY_STORED_DEADLINE_V1` policy basis; it does not prove historical origin, provider truth, or a signed rights statement. Enroll all intended rows only after the fence succeeds; unknown, inconsistent and oversized rows remain blocked. An admin bypass remains outside the maintenance guarantee.

Use an authenticated admin session for enrollment. Set a server statement timeout **in a separate statement before each transaction**; a timeout set inside the statement being timed does not bound that statement. For example, after selecting the owned database and binding values safely in the SQL client:

```sql
SET statement_timeout = '30s';
SELECT lyraseo_legacy_visibility.enroll_scope(:'workspace_id', :'site_id');
SELECT lyraseo_legacy_visibility.enroll_row(:'workspace_id', :'site_id', :'run_id');
```

Repeat the second statement for each intended run. The fence prevents new legacy inline inserts in that site, and blocks ordinary updates and cascaded deletion of its legacy rows. Private-format observations and unrelated sites retain their existing paths. A database restart invalidates the enrollment's postmaster binding; do not reuse it silently.

Connect separately as `lyraseo_artifact_maintenance` to the same owned database. The functions reject a session without a nonzero PostgreSQL `statement_timeout` no greater than 30 seconds. Set it in a prior statement in the same session, not in a CTE or function-local setting. Preview makes no changes and returns a page of IDs, categories and hashes; follow its cursor, and treat the oversized-identifier flag and all blocked or unclassified values as unresolved.

```sql
SET statement_timeout = '30s';
SELECT lyraseo_legacy_visibility.preview(:'workspace_id', :'site_id', 100, NULL);
-- Use the reviewed IDs, in a text array of at most 100, from the same scope.
SELECT lyraseo_legacy_visibility.create_plan(:'workspace_id', :'site_id', ARRAY[:'run_id']::text[]);
-- Retain the returned plan id and hash, and pass them unchanged on every call.
SELECT lyraseo_legacy_visibility.next_items(:'workspace_id', :'site_id', :'plan_id'::uuid, :'plan_hash', 100, NULL);
SELECT lyraseo_legacy_visibility.execute_one(:'workspace_id', :'site_id', :'plan_id'::uuid, :'plan_hash', :'run_id');
SELECT lyraseo_legacy_visibility.status(:'workspace_id', :'site_id', :'plan_id'::uuid, :'plan_hash');
SELECT lyraseo_legacy_visibility.pause(:'workspace_id', :'site_id', :'plan_id'::uuid, :'plan_hash');
```

`busy` and `backoff` are not success. Backoff uses real database time and survives replanning; pagination and a new plan can cover remaining enrolled rows. Pause waits for an admitted execution and prevents later execution on that plan. A matching receipt records the database representation transition and preserved-field hashes, not provider-wire identity or removal of copies. SQL NULL without that matching receipt is unverified, not proof of erasure.

Accepted rows have bounded stored and logical JSON sizes and slot counts. PostgreSQL may decompress a TOAST value while computing its logical size, so these checks and the server statement timeout do not establish a strict pre-decompression memory bound. The historical inline producer accepted up to the reviewed panel's 25 prompts and 100,000 characters per successful answer body; task IDs, failure reasons, annotations and extra runtime input fields were not universally bounded. The classifier deliberately blocks unsupported shapes instead of reconstructing lost historical input. The optional fixture eligibility clock is administrator-enrolled in an isolated local database only; it does not control reads, backoff, plan timing or receipt time.
