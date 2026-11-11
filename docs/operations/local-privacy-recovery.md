# Local privacy and retained-work recovery

This phase-one implementation is disabled by default and qualified **LOCAL_TEST_ONLY**. It operates only on explicitly administrator-enrolled scope in a disposable PostgreSQL database. The two recovery profiles below distinguish selected retained work from a complete known-baseline logical database rehearsal. Neither enables production deletion scheduling, processor erasure, automatic hosting backups or application reopening.

## Retention sweep

Migration `202611030010_privacy_recovery` adds purpose-owned functions under `lyraseo_history`. The existing restricted `lyraseo_artifact_maintenance` login may invoke only the named functions. `lyraseo_history_owner` is a separate NOLOGIN identity with no role memberships, administrative flags, database/table/schema ownership, or caller-controlled SQL path.

An administrator enrolls an exact workspace/site, database OID, postmaster start, policy version and random scope incarnation. Enrollment starts disabled. Neither a customer GUC nor the maintenance login can enroll or enable itself. Runtime, API tokens and dispatch credentials cannot invoke the sweep.

The preview reads at most 100 due identities, original deadlines and source hashes. It writes nothing. Recording requires the exact preview and its PostgreSQL JSONB SHA-256. Applying requires the scoped plan ID and hash; plans expire after one hour. Source changes and new retention protection produce `CHANGED_OR_RETAINED` receipts, not deletion under an obsolete preview. Concurrent applications serialize on the plan. A persisted pause prevents later application.

The supported categories are:

- Unpinned, non-head `ContentRevision` bodies: 90 elapsed UTC days from original creation. `historyExpiresAt` is a stored generated column. The body becomes JSON null; the logical revision and all other original fields remain unchanged. An AFTER trigger verifies the generated expiry as well as the other protected fields. Keeping the logical row preserves `PageJournal` references without turning those references into pins. Existing readers label an expired link unavailable.
- `SearchSnapshot`, completed/failed `SearchImport`, and non-running `AnalyticsImport`: their existing stored 13-calendar-month result expiry. An active import is not purged by this history sweep.

Current authored heads, pinned revisions, reports, contexts, financial receipts and another site's data are outside this sweep. Raw audit/observation artifact expiry remains the separately reviewed artifact workflow. Legacy audit/report remediation is a separate migration. SQL body withdrawal is active-store removal; it does not prove WAL, filesystem media, backup or processor erasure.

## Local operator commands

`scripts/privacy-retention.mjs` supports `history-preview`, `history-record`, `history-apply`, `history-pause`, `case-status` and `case-sweep`. It requires `LYRA_LOCAL_PRIVACY_ENABLED=true` and `LYRA_LOCAL_PRIVACY_CONFIG_FD` naming an inherited descriptor of at least 3. Configuration contains only:

```json
{
  "databaseUrl": "postgresql://lyraseo_artifact_maintenance:<local-password>@127.0.0.1:54329/lyraseo_recovery_<12-hex>",
  "scope": { "workspaceId": "<opaque-id>", "siteId": "<opaque-id>" }
}
```

Supply the descriptor from private operator tooling. Do not put credentials in command arguments or committed files. The command rejects canonical database names, non-loopback addresses, other roles, URL options, arbitrary flags, clock overrides and oversized inputs. Malformed credential-bearing URLs/JSON receive a sanitized configuration error. Configuration and manifest descriptors are separately bounded.

`history-record` takes `--manifest-fd` and `--hash`. `history-apply` takes `--plan-id`, `--hash` and optionally `--limit` (1–100). `history-pause` takes `--plan-id`. Case commands take `--case-id`; case sweep has a 1–12 task bound. Saved status reads dispatch no provider work.

## Independent deletion journal

`openRecoveryJournal` uses an operator-owned canonical private directory and a 32-byte key. Its scope IDs are opaque, and records contain no URLs, content, credentials or provider responses. AES-256-GCM authenticates each entry against policy, partition and sequence; ciphertext hashes bind the previous entry. Writes fsync encrypted pending output, publish by an exclusive hard link, fsync the directory and remove the pending link before returning. No plaintext intermediate file is written.

The frozen journal object is an in-process capability. Deletion admission and archive replay reject forged objects. An intent is persisted before the database deletion transaction. A database receipt is journaled afterward. New admissions include the original acceptance, seven-day cleanup and 180-day marker deadlines in that authenticated receipt; replay never refreshes those clocks. Legacy entries without these receipt clocks cannot qualify a full logical deletion replay. A crash or uncertain response between these steps leaves a pending intent, which blocks recovery reopening. Repeating the same case/request identity resumes it; changed content conflicts.

A separate writer lock serializes processes. An exclusive recovery mutex prevents a normal writer or a second operator recovery from racing lock inspection and removal. A crashed or unknown recovery mutex requires forensics and remains blocked. A live or unknown owner stays blocked. Explicit recovery requires the exact lock-file digest and a recorded owner PID that the OS reports absent; PID reuse remains conservatively blocked. Only abandoned, unpublished pending files or the duplicate pending link to an already published inode may be removed. Published corruption is never silently repaired. An empty/unknown lock requires operator forensics.

**A hash chain cannot prove that a later tail was not removed.** Replay requires both the backup watermark and a separately trusted latest-head watermark. A missing or uncertain latest head blocks replay. Keeping the journal outside the database and archive directories preserves it during those restores, but same-UID local directories are not a deployed access-separated witness. Hosted zero-loss replication, independent trusted watermark custody and recovery-key custody remain acceptance requirements.

## Site deletion admission remains unqualified

**Customer deletion admission is disabled at the database boundary.** Independent review reproduced a restricted runtime call with forged actor/workspace GUCs and an arbitrary journal UUID/sequence/hash that committed a tombstone without a durable journal, authenticated session or MFA. TypeScript flags and genuine journal object checks did not establish database authority. The failed security regression and earlier acceptance receipts are retained; the earlier positive admission results are superseded.

Migration32 now removes runtime/maintenance/PUBLIC EXECUTE on `accept_site`, and its body unconditionally raises `DELETION_ADMISSION_UNQUALIFIED`. Even an accidental future grant cannot enable the old path. The server service validates inputs and current actor prerequisites, then reports the same unqualified state before writing a new journal intent or changing data. Existing unresolved journal intents remain intact. No runtime GUC, per-capability flag or arbitrary hash can turn admission on.

An independent, non-forgeable purpose/issuer binding must establish the exact durable journal intent, actor, current session/security epoch and fresh MFA before admission can be qualified. This implementation does not invent that authority. The preview and bounded staff case metadata remain read-only facilities; no public delete route is enabled.

## Deletion payload cleanup remains unqualified

Review also found that the original `sweep` limit bounded task categories, while whole-site IMPORTS/AUTHORED_PAYLOAD deletes and TEAM_DATA loops could still hold locks for unbounded rows. The maintenance sweep now performs **only bounded metadata transitions**: at most1–12 pending tasks become `NEEDS_ADAPTER` with `BOUNDED_ERASURE_NOT_QUALIFIED`. It never calls bulk payload or agency/handoff/keyword cleanup helpers. It reports zero completed tasks and `allCopiesErased=false`. Repeating a sweep cannot silently perform the disabled work.

Purpose-private TEAM_DATA and optional integration seams remain source drafts, inaccessible to runtime/maintenance and undispatched. Before use, each category needs a bounded keyset batch, durable progress/lease, crash/retry handling and a large multi-batch test. Audit/visibility payloads, artifact-origin generations, processors, backup aging and financial-identity minimization also remain unqualified. Full account/workspace deletion and managed-auth revocation remain separate work.

A test-only `stagePrivilegedSyntheticDeletion` helper requires the postgres fixture role and an owned random recovery database. It stages synthetic tombstone/case facts and genuine external journal events for isolated recovery and safe staff-projection tests. This is privileged fixture setup, **not user-authorized deletion admission**, a production issuer, or payload-erasure acceptance. Production modules do not import it. Original seven-day cleanup and180-day marker clocks remain in the synthetic receipt and signed replay record without refresh.

## Encrypted retained-work archive

`exportRetainedWork` performs one consistent PostgreSQL statement for authorized site work, followed by the existing fresh read-authorization check. It exports current authored heads, pinned/recent authored revisions and compact saved report conclusions. The SQL projection excludes full raw report snapshots before they enter the archive path. Original PDF/CSV bytes are not selected. Export fails visibly if the bounded archive cannot cover all selected work or a draft head is missing.

`localRecoveryPoints` writes a bounded AES-256-GCM archive directly to private ciphertext output, with no plaintext temporary file. Each record carries its scope incarnation, original creation/expiry, classification and SHA-256. Point expiry is seven days from generation and never refreshes on reading or restoration. Verification authenticates the complete point before returning its contents. Inventory shows missing daily coverage; explicit prune removes authenticated points due by age even when no newer point exists.

Replay removes applied deleted-scope incarnations and reapplies original revision TTL. Recreated incarnations remain separate. Pending deletion intents block reopening. Credentials and execution capabilities are never restored. Every rehearsal remains quarantined with `APPLICATION_RESTORE_NOT_QUALIFIED`.

The profile is deliberately `LOCAL_RETAINED_WORK_ONLY`. It omits original report download bytes, imported datasets/audit history, site context/panels/page journals, original author/account attribution and memberships, financial/security archives, integration secrets, sessions and dispatch capabilities. Redacted report conclusions are new derivatives, not historical byte-identical downloads. This verifies recovery of selected non-reproducible work; it does not satisfy the full application/database/storage/financial restore gate, hosted daily backup gate, processor erasure or recovery-time target.

## Complete known-baseline logical rehearsal

`pnpm test:full-backup` implements a separate **LOCAL_FULL_LOGICAL_32_V1** profile, with adapter **BASELINE_27_32_V1**. It covers the complete accepted27 plus32 database graph and a separately authenticated private bundle of saved v2 PDF/CSV bytes. This is a synthetic local rehearsal, not a production backup command. A lab-created capability identifies every new database and private directory; there is no API to adopt an arbitrary existing database or customer URL. Container identity, loopback binding and PostgreSQL system identity are checked before use.

A repeatable-read source snapshot freezes rows and original timestamps. A checked-in catalog qualifies table/column/check/FK definitions, owners, RLS policies, table/column/function privileges and function definitions. Unknown tables or schema changes block capture; additional migrations29–38 require separately reviewed adapters and an updated full-schema acceptance run. The lab deliberately installs only27 plus32 for this versioned test rather than claiming those newer tables were backed up.

Credential/session/OAuth/HMAC and transient raw-source tables are omitted before data reads. Shared projections retain original authored work, context, saved conclusions and minimum financial facts while removing raw HTML/provider answer copies, executable operation inputs and expired result bodies. Unsupported legacy report binary classification blocks capture. Raw origin artifact attachments lose live bindings and are explicitly unavailable after restore. No origin authentication or media/provider erasure is implied.

A newly owned offline projection database receives sanitized rows with original clocks. PostgreSQL creates a complete custom logical dump of that projection; raw source data never enters a dump. Distinct AES-256-GCM keys encrypt the dump and private artifact bundle, and a third key authenticates the manifest. Ciphertext files and parent directories are fsynced. Bounds are 256MiB total capture and 32MiB per row. Every artifact carries original scope, format, length and SHA-256. Points expire seven days after original creation; reads and restores do not extend this deadline. The full profile currently refuses expired points; its independent aging scheduler and production custody remain unqualified.

The rehearsal first verifies that user admission is disabled, then uses explicitly privileged synthetic fixture setup for a later deletion event. This setup does not qualify product deletion authorization. The rehearsal deletes its original synthetic source database before restoration. A new target is created with `ALLOW_CONNECTIONS=false` in the original CREATE statement. While it is still closed, the maintenance database installs private database ACLs and verifies them; only then are admin-only connections enabled. Runtime CONNECT is never available during creation, SQL restore or journal replay. The local harness observes each barrier and attempts competing restricted-runtime connections; an empty owned negative control demonstrates why revocation alone cannot evict a pre-existing session. Manifest, ciphertext, complete decryption and artifact hashes are verified before SQL restore. The external journal must match both the point watermark and independently trusted current head. Replay reapplies original expiry and same-incarnation deletion before product access, validates every FK, and checks the restored catalog again. A signed durable replay receipt retains the source snapshot, current trusted head, original deletion clocks and explicit quarantine status. It does not fabricate missing post-backup case/task attribution; those later receipt facts survive in the signed replay record. The target keeps sessions and integrations disconnected, users suspended, staff grants disabled, policy switches off and dispatch suppressed. Financial reservations, statuses, fences, balances and receipts remain unchanged.

The controlled acceptance probe temporarily unsuspends only two fixture users with incremented security epochs and permits runtime CONNECT. Actual authorized draft/report/audit services must preserve authored bytes, saved PDF/CSV hashes and the frozen score; stale credentials, another tenant's report and the deleted site must fail. The probe then re-suspends users and revokes CONNECT again. It never sends provider work. Tests also reject corruption, missing bundle, wrong key, manifest expiry tampering and an untrusted latest journal head.

This satisfies a **complete known-baseline synthetic logical restore rehearsal**, with saved private download artifacts and documented raw-source exclusions. It does not qualify the combined29–38 application, deployed artifact-store provenance, production key custody or independent witness replication, hosted backup scheduling, production RPO/RTO, external processor erasure or operational reopening. The source and restored objects are deleted only by their own lab handles after recording acceptance results.

## Verification

Run `pnpm test:history-retention` on the validated local PG17 container. The required gate creates its own random template0 database, applies migrations, runs the local bootstrap there, executes the real restricted-role recovery suite and drops only its own created database. It never resets the canonical database or restarts the server. Unit tests exercise archive authentication, corruption, age boundaries, original-clock replay, independently trusted journal heads, restart, idempotency, concurrent intents, dead-owner recovery and CLI rejection/redaction.

The combined release candidate still needs full raw repository checks, migrations from populated accepted history, all new-module erasure seams, combined-schema isolated application restore and protected live acceptance. Keep these gates separate from the local tests above.

To test final agency31 in this isolated earlier checkout, set `LYRA_RECOVERY_TEAM_MIGRATION` to its exact `202611030009_agency_team/migration.sql` path and run `node scripts/test-history-retention.mjs`. The harness verifies the file belongs to a worktree of the same Git repository, records its SHA-256, applies it only in the newly created owned database before32, and runs tests proving disabled admission/cleanup preserve agency records and expose the explicit incomplete state. In the integrated checkout, its local31 migration enables these tests automatically. External migration files are read only.
