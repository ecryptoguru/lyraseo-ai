# Phase-one final review — 2026-11-10

Scope: private phase one only, using the existing Next.js/Node/Workers/PostgreSQL architecture. The approved handoff and implementation plan remain authoritative. Local fixtures are not hosted or provider acceptance.

- [x] Inventory branch, PR and exact-source CI without changing the primary checkout. Starting revision: `866182001ae04199b47c01ad9f11f429055ce1bd`; PR #15 remains draft. Both latest CI runs failed at backup catalog qualification.
- [x] Diagnose the actual CI catalog mismatch; preserve security metadata and failing receipts. Only two contaminated `INHERIT` booleans were corrected; extension-version checking restored.
- [x] Independently review backup projection and fix verified dependency, financial-queue, commitment and retention defects. Populated billing/batch restore and pre-publication FK validation pass; remaining graph/authority qualification is explicitly open.
- [x] Review MFA/history and per-socket audit authorization; apply fail-closed enrollment/re-entry mitigations and current-actor/lease guards. Trusted recovery remains unimplemented.
- [x] Stop integration resets from targeting shared `lyraseo_test`; run the exact reviewed Search Console R2 bytes on a new owned restricted-role database.
- [x] Reconcile source with the approved phase-one handoff; record missing implementation separately from account/hosting and live acceptance in `docs/phase-one-final-review-findings.md`.
- [x] Run raw local check/format/unit/build, safe integration, browser/crawler/worker, catalog and backup/integrity gates; retain exits, failures and skips privately. Dedicated release gates and final exact-source CI remain required.
- [ ] Publish reviewed fixes and an accurate draft-PR status. Do not merge or declare pilot completion with failing CI, missing implementation or unverified live gates.

Constraints: $10 per user per UTC month combined; $8 Azure / $1 Parallel / $1 DataForSEO; 25 API / 100 ChatGPT / 100 Gemini observations. No purchases, automatic top-ups, phase-two work, domain acquisition, or enabling unqualified customer execution. Preserve existing databases, volumes, source fixtures and user work.
