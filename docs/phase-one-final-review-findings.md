# Private phase-one final review — 2026-11-10

## Release verdict

**Not ready for private-pilot acceptance or merge.** Previous conversation summaries saying phase one was complete, or that only credentials remained, were incorrect. The source deliberately leaves several approved workflows unavailable. Passing synthetic tests cannot establish provider, hosted or user acceptance.

Starting source: `866182001ae04199b47c01ad9f11f429055ce1bd`; draft PR [#15](https://github.com/ecryptoguru/lyraseo-ai/pull/15). Both exact-source verification runs failed at backup catalog qualification. No hosted deployment receipts were returned by the repository deployment inventory. Read-only auth preflight stopped before network access because all six required settings were missing.

The primary checkout does contain a protected mode-0600 runtime environment. A second preflight used that existing file read-only, without copying or printing its contents. Provider settings were reachable, but the gate stopped at **Google sign-in not enabled**, before database checks. Earlier provisioning notes are not current Google/OTP/MFA acceptance.

## Confirmed defects and mitigations

1. **Contaminated backup fixture:** runtime and identity roles were recorded as `INHERIT` from an old local cluster. Fresh CI correctly uses `NOINHERIT`. The failure was reproduced on CI's PostgreSQL image and matched its exact error hash. Correct only these two fixture booleans; retain extension-version and privilege checks. Do not relax runtime roles or regenerate the fixture wholesale.
2. **Factorless enrollment/re-entry:** current factor absence cannot establish that MFA never existed. Initial enrollment is now withheld, and factorless identities are rejected before product provisioning until trusted history is implemented. Backup confirmation requires a current verified primary and fresh AAL2, with session/epoch rechecks before and after verification. This is a temporary availability restriction, not a change to the approved optional-customer-MFA policy.
3. **Audit authorization after DNS:** audit steps must pass a current-actor resolver to the guarded transport and recheck scope, capability, verification and lease/fence before every socket. Authorization loss aborts acquisition; it must not become a fabricated failure capture. Local-only acquisition gating stays in place.
4. **Unsafe integration target:** destructive integration fixtures previously defaulted to the shared `lyraseo_test`. The owned runner creates a new random database, verifies the container/server and restricted roles, and migrates only that target. The shared database is not an integration-reset target.
5. **Backup dependency coverage:** deletion-case graph/clocks, assignment-event cascades, financial queues, committed batch receipts, required access receipts and routable handoff paths now have explicit projection regressions. Workspace tombstones and unclassified shapes fail closed. Foreign keys are validated before a point is signed, with a real PostgreSQL orphan/rollback negative control. The expanded restore rehearsal seeds nonempty billing account/binding/event/discovery/inbox and an expired confirmed/admitted batch/quote graph; it checks retained confirmation dates, operation links and SQL `infinity` quarantine clocks. Populated ledger/handoff variants, legacy report preservation and the remaining authority-catalog checks still need qualification.

## Remaining implementation, not account setup

| Workflow | Required work before enablement |
| --- | --- |
| Identity and recovery | Trusted durable initial/prior MFA eligibility; case-bound recovery with the approved 72-hour hold, notices, revocation and provider-authority verification; staff enrollment-only bootstrap. No AAL1 reset shortcut. |
| Customer durable execution | Wire customer admission to durable dispatch, queue/worker and recovery. The existing signed carrier is a controlled harness; browser-driven audit steps are not hosted durable execution. |
| Provider quotes and observations | Server-owned account/tariff/rights qualification, independently authenticated carrier, operation/fence-bound tickets, live receipts, reconciliation, private source production, and separate surface enablement. Fixture-only ledger/source principals remain synthetic. |
| Editorial and research | Qualified Azure generation and Parallel research wired through normal admission/settlement; current assistance is an explicitly labelled template. |
| Keyword enrichment and delivery | Executable qualified keyword quotes; qualified customer WordPress draft-only and signed-webhook admission/carrier. Current null quotes and quarantined intents remain unavailable. |
| Deletion and operations | Qualified deletion issuer, bounded payload adapters and processor receipts; qualified staff provider-session authority and pause/retry execution. Metadata sweeping is not erasure. R4 remains unintegrated. |
| Backup and restore | Populated dependency/financial/retention coverage; historical report preservation; database/default ACL, role-setting and crypto-extension membership checks. Current 39-schema support does not by itself preserve older backup-profile compatibility. |

## External acceptance prerequisites

After the corresponding implementation is qualified: eligible protected Vercel hosting; dedicated Supabase auth/database roles and Gmail delivery; an owned public fixture site and invited private tester; Azure deployments/tariffs/grounding bounds; Parallel account rights; separately eligible DataForSEO ChatGPT/Gemini English/India settings and trial balance; controlled GSC/optional GA4 properties; and test WordPress/webhook endpoints. Never request credentials in chat or purchase deposits/upgrades automatically.

Preserve the $10/user/UTC-month combined ceiling, $8 Azure / $1 Parallel / $1 DataForSEO partitions and separate 25 API / 100 ChatGPT / 100 Gemini observation limits. No paid calls, top-ups, phase-two work or domain acquisition occurred in this review.

## Verification qualifications

Fresh local verification for this review's assembled source:

- `pnpm check`, `pnpm format:check`, `pnpm build`: exit 0.
- `pnpm test:unit`: 787 passed across 69 files.
- Safe `pnpm test:integration`: 411 passed; 80 dedicated-gate tests skipped. Full failing runs were retained before the two restricted-login URL bugs and controlled legacy-clock fixture were fixed.
- `pnpm test:crawler`: 34 passed. `pnpm test:worker`: 64 harness tests (47 prior + 17 safety) and 77 real local bridge tests passed on the selected disposable cluster.
- `pnpm test:e2e`: 169 desktop/mobile fixture tests passed; one desktop-only intentional skip.
- `pnpm test:full-backup`: 12 controlled checks passed, including populated billing queues/committed batch preservation; runtime connections remained denied. `test-current-backup-catalog.mjs` and `test-backup-integrity.mjs` passed independently.

These are not hosted, provider or full recovery-parity acceptance. Dedicated expiry/legacy/handoff/ledger/staff/replay gates must run in exact-source CI and are not credited merely because they passed on an earlier revision. Do not mark the draft PR ready for merge on these local receipts alone.

Raw local receipts are private under the approved OpenCode temporary directory and `output/integration-owned/`; neither belongs in the public commit. Record final command exits, source hashes, skipped tests and CI IDs separately. The generic `checklist.py` returned zero but skipped **all six** checks because their scripts are absent; that is not validation evidence. Use repository lint/type, unit, PostgreSQL, browser and explicit security review receipts instead.
