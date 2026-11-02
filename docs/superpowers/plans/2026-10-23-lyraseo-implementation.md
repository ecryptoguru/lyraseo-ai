# LyraSEO AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task only after explicit build authorization. Steps use checkbox syntax for tracking. The founder subsequently authorized phase-one local execution on 2026-10-23. The document alone authorizes no phase-two work, paid upgrades, purchases or cloud provisioning. See the progress ledger for actual implementation status.

**Goal:** Deliver the approved broad private pilot, then the domain-gated production phase, without changing business decisions or adding infrastructure prematurely.

**Architecture:** One Next.js web app, one Cloudflare worker, one dedicated Supabase PostgreSQL database managed through Prisma, private R2 and a database-backed job/outbox ledger. Deterministic rules are pure; provider calls are explicit, bounded and separately accounted. Auth is Supabase in private testing and Better Auth before customer launch.

**Tech Stack:** TypeScript/pnpm, Next.js/React, Tailwind/shadcn, Prisma/PostgreSQL, Cloudflare Workers/Queues/Browser Run/R2, Azure OpenAI Sol/Luna, Parallel Search/Extract, DataForSEO Standard, Gmail SMTP then Brevo, Razorpay/Polar sandbox then live, PostHog only phase 2.

## Global constraints

- Phase-one local building is now authorized; implementation progress is tracked in docs/evidence/phase-one-progress.md. Business decisions remain deferred in the [review](../../product-quality-and-optimization.md#83-what-remains-to-finalize-later).
- [Engineering contracts](../../engineering-contracts.md) and [audit/measurement contracts](../../audit-and-measurement-contracts.md) are the written technical baseline. Approved scope, security, privacy and budget policies prevail.
- $0 paid infrastructure initially; no upgrade, deposit, domain purchase or additional paid service without approval. $10 per admitted user per UTC month, split $8 Azure/$1 Parallel/$1 DataForSEO; 25 API plus200 consumer observations. No editorial/research/helper monthly quotas.
- No LyraShield runtime, accounts, secrets, queues, database, billing or deployment dependency.
- Phase 1 stays private, including previews and APIs. All16 FULL modules retain their mapped phase-one portions. Customer automation/advanced administration, Better Auth, Brevo and PostHog follow phase2.
- Domain control precedes phase-two implementation. Marketing apex, app subdomain and app-host `/admin`; one codebase/Vercel project.
- Preserve approved design/brand assets, retained data, identities and budget history; Better Auth requires fresh sign-in and preserved MFA.
- No additional public pricing, site/member quotas, grace/refund policy, provider fallback or silent feature cut. Unavailable providers produce honest unavailable states.
- Dates use UTC storage with user-timezone display; provider GSC dates retain their semantics. Retention/deletion applies throughout.

## 1. Planned file map and commands

All paths below are proposed new files, not an existing application. Use the actual compatible package/version APIs selected in Task1; do not copy illustrative signatures into vendor calls blindly.

| Path | Responsibility |
| ---- | -------------- |
| `apps/lyraseo-web/src/app/` | Marketing, auth, customer routes, staff routes and versioned API handlers |
| `apps/lyraseo-web/src/server/auth/` | Provider adapter, step-up and verified actor resolution |
| `apps/lyraseo-web/src/server/services/` | Tenant-authorized domain services used directly by server components and API routes |
| `apps/lyraseo-web/src/components/` | Shared approved UI primitives and workflow compositions |
| `apps/lyraseo-worker/src/index.ts` | Fetch/internal, queue and scheduled dispatch entry points |
| `apps/lyraseo-worker/src/jobs/` | Operation/step executors, polling, cleanup and reconciliation |
| `packages/contracts/src/` | Zod request/event/output schemas and shared types |
| `packages/db/` | Product schema, SQL migrations, restricted runtime clients and transactional services |
| `packages/visibility/src/` | URL normalization, extraction, rules, scoring, comparison and observation metrics |
| `tests/unit/`, `tests/integration/`, `tests/e2e/`, `tests/fixtures/` | Pure, PostgreSQL, browser and synthetic evidence suites |
| `docs/runbooks/`, `docs/evidence/` | Setup/recovery instructions and sanitized verification receipts |

Task1 must define these root scripts: `pnpm check` (lint+types), `pnpm test:unit`, `pnpm test:integration` (isolated local PostgreSQL only), `pnpm test:e2e` (local fixtures), `pnpm build`. Each test script accepts a test-file argument. CI uses frozen lockfile and no real provider secrets. Live acceptance is a separate explicitly invoked task using a declared test corpus and budget, never every pull request. Final checks use raw output.

## 2. Phase-one sequence

### Task 1: Local workspace and compatibility proof

**Depends on:** explicit build authorization. **Files:** root `package.json`, `pnpm-workspace.yaml`, safe `.env.example`, app/package manifests, `tests/unit/config.test.ts`, `docs/evidence/runtime-compatibility.md`.

**Interfaces:** `readConfig(env: Record<string,string|undefined>): Config` returns validated environment/runtime and configured optional capabilities; Config contains environment, public origin, DB endpoints and capability flags, never returns secrets to browser bundles.

- [ ] Inspect actual repository and instructions; activate Serena before source work. Preserve existing assets/docs and any new user changes.
- [ ] Select/pin compatible versions and create the file map/scripts above; keep optional provider credentials absent in local fixture mode.
- [ ] Add tests: missing required local DB configuration fails with safe names only; absent optional Azure/SMTP credentials marks those capabilities unavailable; server secret fields are excluded from client configuration.
- [ ] Run `pnpm test:unit tests/unit/config.test.ts`, then `pnpm check` and `pnpm build`. Record exact versions and both Node/Worker smoke results.
- [ ] Probe local Prisma transaction/pooling and Worker parsing size/CPU with synthetic fixtures. Document live Browser Run isolation, Supabase metadata and provider access as unverified until separately checked. A failed live prerequisite does not justify new paid dependencies.

**Exit:** reproducible local skeleton and fixture mode; no customer/provider capability claimed. Suggested effort:3–5 engineering days.

### Task 2: Product schema and authorization

**Files:** `packages/db/schema/`, `packages/db/migrations/`, `packages/db/src/tenancy.ts`, `packages/contracts/src/auth.ts`, `tests/integration/tenancy.test.ts`.

**Interfaces:** ProductUser/provider mapping and records from engineering section2; `authorize(actor,action,scope): Promise<void>` and transaction-scoped tenant service entry points. No provider subject used as product ownership key.

- [ ] Write integration cases for cross-workspace nested IDs, site grants, owner/admin/editor/viewer actions, token intersection, separate staff grants and simultaneous last-owner removals.
- [ ] Implement composite constraints, unique keys, indexes and restricted roles; explicit tenant predicates on every service operation. Add no phase-two tables.
- [ ] Exercise the actual runtime DB role directly: public/anonymous access denied; migration role separate; application role's RLS behavior documented.
- [ ] Run `pnpm test:integration tests/integration/tenancy.test.ts` on a clean migrated DB and a migration replay. Confirm exactly one simultaneous owner-removal attempt can succeed when otherwise leaving no owner.

**Exit:** tenant isolation enforced in service paths and schema; no UI-only authorization. Effort:4–7 days.

### Task 3: Supabase auth, Gmail and recovery

**Files:** `apps/lyraseo-web/src/server/auth/supabase.ts`, `step-up.ts`, auth pages, `server/email/gmail.ts`, `tests/integration/auth.test.ts`, `tests/e2e/auth.spec.ts`, `docs/runbooks/account-recovery.md`.

**Interfaces:** `resolveActor(request): Promise<Actor>` as engineering section2; `consumeStepUp(actor,action,resourceId,token): Promise<void>`; product email outbox references template/recipient IDs. Supabase remains OTP issuer.

- [ ] Test Google/OTP return paths, private allowlist, linking ambiguity, enrolled MFA after both login methods, revoked sessions,30-day lifetime, refresh inactivity, ten-minute step-up and invitation expiry.
- [ ] Implement provider-supported verification and mandatory staff MFA. Never derive fresh auth from JWT refresh; verify authoritative refresh metadata before hosted testing.
- [ ] Implement Gmail delivery and privacy-safe status using fake SMTP locally; create recovery case states VERIFYING → HOLD → APPROVED/DENIED → COMPLETED with operator action after minimum72h and restricted factor replacement.
- [ ] Run `pnpm test:integration tests/integration/auth.test.ts` and `pnpm test:e2e tests/e2e/auth.spec.ts`. Test OTP expiry/delivery failure, MFA loss, duplicate acceptance and safe draft preservation.
- [ ] Later, verify actual SMTP account delivery and Supabase session behavior on controlled identities before enabling private users; record any Free-plan limitation instead of marking fixtures as live proof.

**Exit:** private identity and recovery boundaries verified locally; live gate separately recorded. Effort:5–8 days.

### Task 4: Durable operations and budget ledger

**Files:** `packages/contracts/src/operations.ts`, `packages/db/src/admission.ts`, `settlement.ts`, `apps/lyraseo-worker/src/jobs/dispatcher.ts`, `executor.ts`, `tests/integration/operations.test.ts`.

**Interfaces:** `admitOperation(actor,request,idempotencyKey): Promise<{operationId:string}>`; `settleOperation(operationId,receipts): Promise<void>`; request/receipts carry typed immutable scope/provider cost per engineering sections3–4.

- [ ] Write races: two $0.30 reservations with only $0.40 left →one accepted; same key/body →same operation; changed body →409; duplicate receipt →one settlement; UTC rollover →original period retained.
- [ ] Implement short admission transactions, exact decimal costs, outbox, lease/fencing, bounded dispatch/retries and cancellation. No provider calls in DB transactions.
- [ ] Inject crash after intent, after provider acceptance, before receipt, after result and before settlement; uncertain acceptance enters RECONCILING without a second charge.
- [ ] Run `pnpm test:integration tests/integration/operations.test.ts`; simulate expired Queue message and stale lease, and verify DB reconciliation recovers once. At90% usage, affordable work still admits.

**Exit:** durable state and internal accounting, including cancellation ambiguity. Effort:5–8 days.

### Task 5: Verification, discovery and safe acquisition

**Files:** `packages/visibility/src/url.ts`, `apps/lyraseo-worker/src/jobs/acquire.ts`, `packages/contracts/src/evidence.ts`, `server/services/sites.ts`, `tests/unit/urls.test.ts`, `tests/integration/acquisition.test.ts`.

**Interfaces:** `normalizeUrl(input:string): string`; `acquirePage(operationId,pageUrl): Promise<PageEvidence>` uses persisted manifest and guarded fetch/browser bindings, never caller authority.

- [ ] Add fixtures for URL normalization, IPv4/IPv6/reserved/rebinding, redirects, subresources, invalid MIME, oversized bodies, robots denial and sitemap loops.
- [ ] Implement DNS/file proof, bounded discovery and immutable≤25-page manifest; raw and rendered evidence remain separate. Stream/check sizes before parsing.
- [ ] Run `pnpm test:unit tests/unit/urls.test.ts` and `pnpm test:integration tests/integration/acquisition.test.ts`; prove timed-out page is UNKNOWN, not404.
- [ ] Under later setup authorization, verify Browser Run isolation and actual Worker CPU/memory/free budget. If isolation cannot be established, keep live crawling disabled and report the concrete conflict.

**Exit:** bounded acquisition with evidence provenance; no unsupported isolation claim. Effort:5–9 days.

### Task 6: Deterministic rules and comparison

**Files:** `packages/visibility/src/rules/`, `score.ts`, `compare.ts`, `tests/fixtures/readiness/`, `tests/unit/readiness.test.ts`.

**Interfaces:** `evaluateAudit(input:AuditEvidence): AuditEvaluation`; `compareAudits(before:AuditEvaluation,after:AuditEvaluation): AuditComparison`. Inputs/outputs contain the rule, manifest, scope and version fields specified in the rule contract.

- [ ] Encode every rule-table branch and named fixture in the audit contract as golden input/expected output, including applicability and missing evidence.
- [ ] Implement pure extraction/rules/math, without IO/clock/models. Add exact decimal or rational aggregation and one half-up rounding.
- [ ] Test category scores1/.5/0/1 →63; removing all-N/A entity category →53; unknown-only category →null. Test removed pages, external canonicals, no schema and review status without score changes.
- [ ] Run `pnpm test:unit tests/unit/readiness.test.ts`; run determinism/property checks and human fixture review before enabling findings for users.

**Exit:** published versioned methodology and reproducible fixtures. Effort:5–8 days.

### Task 7: Approved UI and core audit journey

**Files:** app marketing/auth/workspace/site/audit/issues routes, `src/components/`, styles/token files, `tests/e2e/audit-journey.spec.ts`, `docs/evidence/ui-core.md`.

**Interfaces:** authorized server services from Tasks2–6; GET operation status envelope. UI never queries tenant product tables directly from the browser.

- [ ] Apply Impeccable to the approved Launch Review briefs/assets; build semantic tokens/themes and accessible primitives. Keep private CTA and gated preview.
- [ ] Implement site verification →manifest confirmation →progress →issue/evidence→review→same-scope rerun/comparison, with truthful partial and unavailable results.
- [ ] Add browser cases for empty/queued/partial/expired/cancelled/permission-lost states, preserved filters/focus/scroll, budget-paused state and no automatic paid replay after login.
- [ ] Run `pnpm test:e2e tests/e2e/audit-journey.spec.ts`; inspect mobile/tablet/desktop and both app themes together, then batch corrections and one verification pass. Test keyboard, zoom and reduced motion.

**Exit:** complete core loop using fixture providers, not rasterized mockups. Effort:6–10 days.

### Task 8: Reports and agency workflows

**Files:** `server/services/reports.ts`, `server/jobs/pdf.ts`, agency/client/report routes, `tests/integration/exports.test.ts`, `tests/e2e/agency.spec.ts`.

**Interfaces:** `requestExport(actor,{siteId,resultId,format,brandingVersion}): Promise<{operationId?:string,artifactId?:string}>`; authorized Artifact retrieval and independent batch admissions.

- [ ] Test client access to only granted sites, branding ownership, per-site batch failures and total reservation confirmation.
- [ ] Implement PDF/CSV exports from stored evidence, safe brand uploads, report cache, portfolios, assignments and authenticated client portal.
- [ ] Verify no external PDF fetch, CSV formula-neutralization, private five-minute downloads and expired input labels. Saved final reports follow saved-work retention.
- [ ] Run `pnpm test:integration tests/integration/exports.test.ts` and `pnpm test:e2e tests/e2e/agency.spec.ts`; visually inspect rendered PDF and mobile client portal.

**Exit:** agency/report features retained without custom-domain portals or pooled wallets. Effort:4–7 days.

### Task 9: Azure editorial and Parallel research

**Files:** `apps/lyraseo-worker/src/providers/azure.ts`, `parallel.ts`, `jobs/content.ts`, content/research UI, `tests/integration/content.test.ts`, `tests/fixtures/content/`.

**Interfaces:** `generateContent(inputRefs,configuration): Promise<ContentOutput>` returns versioned text/source IDs/assumptions/usage receipt; `researchSources(request): Promise<ResearchSnapshot>` returns cited bounded excerpts and freshness.

- [ ] Test injected source instructions, unknown citations, truncated output, revision conflict, expired source and provider budget exhaustion with synthetic responses.
- [ ] Implement one Azure client/two deployments, Sol medium/Luna low defaults, no tools on editorial calls; one retry/repair shares the reservation. Implement Search/Extract and24h workspace cache.
- [ ] Implement evidence/draft editing, briefs, cross-page strategy and factual JSON-LD export, with explicit actions and no content count quota.
- [ ] Run `pnpm test:integration tests/integration/content.test.ts`; later measure controlled groundedness, accepted-output cost and latency under verified Azure tariffs and authorized spend. Unsupported models/tools remain unavailable.

**Exit:** grounded user-reviewed generation without autonomous chains or hidden quality downgrade. Effort:5–8 days.

### Task 10: AI observations and competitor metrics

**Files:** `apps/lyraseo-worker/src/providers/dataforseo.ts`, `jobs/observations.ts`, `packages/visibility/src/metrics.ts`, visibility/panel/competitor routes, `tests/unit/metrics.test.ts`, `tests/integration/observations.test.ts`.

**Interfaces:** `computeVisibility(observations,cohort,brandSet): VisibilityMetrics` is pure; observation acquisition returns the exact surface/profile/configuration, raw-artifact reference, extraction state and charge receipt.

- [ ] Encode every metric fixture from the audit/measurement contract: no-brand, unavailable, ambiguity, annotation-only citations, SOV, unequal repetitions and incompatible trends.
- [ ] Implement manual Azure Sol API and DataForSEO Standard ChatGPT/Gemini jobs; persist task IDs and poll accepted tasks instead of resubmitting. English/India intent and confirmed locality remain separate.
- [ ] Implement panels, explicit alias review, separate surface dashboards, competitor/SOV views and portfolio comparisons. Optional Luna classification uses remaining budget and leaves unknown when unavailable.
- [ ] Run `pnpm test:unit tests/unit/metrics.test.ts` and `pnpm test:integration tests/integration/observations.test.ts`; test per-user25/100/100 limits across workspaces and cancellation with remote charges.
- [ ] Later verify actual surface/locality/evidence rights and cost receipts. Synthetic results stay labelled and separate; no live tests until deposit/access requirements are resolved.

**Exit:** honest sampled measurement with exact denominators, not a universal AI rank. Effort:5–8 days.

### Task 11: GSC and external handoffs

**Files:** GSC OAuth/import service, `server/integrations/wordpress.ts`, worker webhook sender, API-token service/settings, `tests/integration/integrations.test.ts`.

**Interfaces:** `refreshSearchConnection(connectionId): Promise<ImportReceipt>`; `createWordPressDraft(operationId): Promise<HandoffReceipt>` with confirmed/unresolved status; outbound event schema from engineering section6.

- [ ] Test OAuth state/property ownership, expired refresh token, partial pagination, CTR/position aggregation, revoked connection and disconnect purge.
- [ ] Implement GSC backfill/daily integration refresh, settings, readonly scoped API tokens, signed outbound webhooks and explicit WordPress draft handoff.
- [ ] Test unsafe destinations, token privilege loss, signature/replay, response bounds and uncertain accepted WordPress writes without duplicate POST.
- [ ] Run `pnpm test:integration tests/integration/integrations.test.ts`; later verify controlled GSC/WordPress accounts and signed delivery before claiming live acceptance.

**Exit:** all retained integrations, with clear reconnect/unresolved states. Effort:5–8 days.

### Task 12: Sandbox billing and lean staff admin

**Files:** `server/billing/razorpay.ts`, `polar.ts`, billing-state service, staff routes, `tests/integration/billing.test.ts`, `tests/e2e/admin.spec.ts`.

**Interfaces:** `processBillingEvent(provider,rawBody,signature): Promise<void>` reconciles normalized state; staff actions delegate to existing operation/recovery services, never direct balance edits.

- [ ] Test valid/invalid signatures, duplicate/out-of-order events, pending checkout, renewal/failure/cancel/refund/dispute, and simultaneous cross-provider subscription admission.
- [ ] Implement sandbox-only fixtures/price mappings and readonly reconciled status; no live checkout or guessed business policy.
- [ ] Build approved staff search, jobs, usage, sandbox reconcile, recovery/privacy cases, kill switches and audit trail. Require MFA/step-up and case-specific content access.
- [ ] Run `pnpm test:integration tests/integration/billing.test.ts` and `pnpm test:e2e tests/e2e/admin.spec.ts`; prove customer owner/admin cannot access staff endpoints or arbitrary content.

**Exit:** sandbox financial correctness and bounded operator support. Effort:5–8 days.

### Task 13: Retention, backup and integrated private-pilot gate

**Files:** worker cleanup/reconcile jobs, backup/restore scripts, `docs/runbooks/{restore,deletion,provider-outage}.md`, `tests/integration/privacy.test.ts`, `tests/e2e/pilot.spec.ts`, CI workflow, `docs/evidence/private-pilot.md`.

**Interfaces:** `deleteScope(actor,scope,stepUp): Promise<{operationId:string}>`; cleanup enumerates Artifact/category records; restore accepts backup plus external deletion/revocation journal and keeps access disabled until reconciliation passes.

- [ ] Test TTL boundary reads, last-owner deletion, in-flight callbacks, saved copies, processor failure, cancelled subscription, and no resurrection after restoring an older snapshot.
- [ ] Implement daily bounded cleanup, security-record archive, encrypted DB/saved-artifact backups, seven-point expiry and restore-time journal replay. No paid add-ons or PostHog.
- [ ] Run `pnpm test:integration tests/integration/privacy.test.ts` and `pnpm test:e2e tests/e2e/pilot.spec.ts`; execute restore on isolated synthetic data and measure the approved target.
- [ ] Run raw `pnpm check`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm build`; record exact revision, test/config versions and failures. CI repeats fixture checks without paid providers.
- [ ] Before invitations, resolve intended cohort, eligible hosting, secrets and authorized provider funding. Verify real provider/auth/email/backup acceptance separately. No public launch or paid customer admission.

**Exit:** private-pilot readiness evidence for every included capability, with any blocked live gate explicitly visible. Effort:6–10 days.

## 3. Phase-two sequence — domain and separate authorization first

### Task 14: Domain routing, Better Auth and Brevo cutover

**Files:** host routing, `server/auth/better-auth.ts`, Prisma auth migrations, `server/email/brevo.ts`, migration/reconciliation runbook, `tests/e2e/auth-cutover.spec.ts`.

**Interfaces:** same Actor/authorization and email-purpose contracts; new provider subject mapping preserves ProductUser IDs. No second active production identity authority.

- [ ] Confirm owned domain and approved deployment spending before phase-two implementation. Test exact app/apex route mapping, host-only cookies, callbacks and private-cache isolation.
- [ ] Rehearse preserved identities/workspaces/data/budgets, invalidated sessions, fresh login and MFA continuity/re-enrollment on synthetic copies.
- [ ] Implement Better Auth server MFA gating after Google/OTP and verified Brevo delivery/retention settings. Test holds/notices, revoked sessions and rollback without restoring deleted data.
- [ ] Run `pnpm test:e2e tests/e2e/auth-cutover.spec.ts` plus auth/tenancy integration suites. Perform controlled live cutover verification before customer admission.

**Exit:** production identity/email contracts demonstrated, not assumed from migration examples. Effort:6–10 days.

### Task 15: Customer automation and advanced administration

**Files:** Schedule/AlertPreference migrations, worker schedule/digest handlers, schedule/settings UI, advanced staff capabilities, `tests/integration/schedules.test.ts`, `tests/integration/advanced-admin.test.ts`.

**Interfaces:** schedule occurrence identity and dispatch contract from engineering section9; privileged actions reuse authorize/step-up and append-only audit/financial receipts.

- [ ] Test daily/weekly IANA slots, spring gap/fall overlap, missed slots, duplicate tick, revoked owner/site, changed panel and budget exhaustion.
- [ ] Implement opt-in schedules/digests/preferences with explicit owner and no catch-up storm; no automatic rewrites or publishing.
- [ ] Implement scoped staff roles, case-bound read-only impersonation, bounded bulk work and reasoned finance actions only under finalized commercial permissions/policy.
- [ ] Run `pnpm test:integration tests/integration/schedules.test.ts` and `pnpm test:integration tests/integration/advanced-admin.test.ts`; verify impersonation cannot perform billing/auth/deletion mutations.

**Exit:** recurring customer work and advanced admin with audited authority. Effort:7–12 days.

### Task 16: Telemetry, live commerce and production acceptance

**Files:** PostHog adapters/event schemas, finalized price/config mappings, public pricing/policy surfaces, `tests/integration/telemetry.test.ts`, `tests/e2e/production-journey.spec.ts`, `docs/evidence/production.md`.

**Interfaces:** explicit event allowlist/scrubber; normalized billing adapter unchanged. No commercial value is chosen by this plan.

- [ ] Apply separately finalized prices/terms/currencies, production budget/recovery and PostHog consent/retention/volume settings. Keep blocked configuration visibly disabled until decided.
- [ ] Test telemetry excludes content/URLs/tokens/IPs; verify exceptions from web/server/worker and source-map releases. No replay, autocapture or phase-one backlog.
- [ ] Exercise controlled Razorpay/Polar customer journeys, auth/email, all retained modules, deletion and restoration under the actual production configuration.
- [ ] Run raw full checks and `pnpm test:e2e tests/e2e/production-journey.spec.ts`; separate source/local, CI, deployment and authenticated provider evidence. Obtain founder release decision on the concrete evidence.

**Exit:** accepted production release only after business/provider gates pass. Effort:5–9 days.

## 4. Coverage, estimate and stopping conditions

| FULL module | Primary tasks |
| ----------- | ------------- |
| 01 Preview | 4,5,6,7 |
| 02 Accounts | 2,3,14 |
| 03 Sites/discovery | 2,5,7 |
| 04 Audits | 4,5,6,7 |
| 05 Issues/comparisons | 6,7,8 |
| 06 Reports | 8,13 |
| 07 Editorial | 9 |
| 08 Briefs/research | 9 |
| 09 GSC | 11 |
| 10 Schedules/alerts | 3,4 for essential internal work;15 for customer automation |
| 11 Visibility | 10 |
| 12 Competitors | 10 |
| 13 Agency/team | 2,8 |
| 14 Integrations | 11 |
| 15 Billing | 4,12,16 |
| 16 Operations/privacy | 3,4,12,13,15,16 |

Planning estimate: phase1 **63–104 engineering days**, phase2 **18–31**, total **81–135** hands-on engineering days for the retained broad scope, not a fixed delivery promise. Provider access, reviews, domain purchase, legal/business decisions and external approval waits are excluded. Re-estimate after Tasks1–6 establish runtime and audit complexity; do not revive the obsolete deterministic-MVP estimate. Task UI/testing effort is included, with phase gates covering integration/restore work. One engineer's calendar duration depends on availability; agent assistance is not a guarantee of proportional speedup.

Prefer smaller internal milestones over parallel infrastructure: core audit loop through Task7; complete private pilot through Task13; domain-gated production Tasks14–16. These are implementation order, not removal of retained features from phase1. Use local synthetic fixtures by default; paid provider calls only for the targeted acceptance corpus. Review each task's diff and evidence before proceeding; create commits only within an authorized repository workflow, never bulk-stage unrelated files.

Stop affected live work when safe browser isolation, supported auth/MFA, accurate cost reservation, tenant isolation or deletion/recovery cannot be proven. Return a concrete scope/cost tradeoff to the founder. Do not compensate with undocumented feature cuts, extra vendors or weaker quality. Business decisions stay parked until their named gate. No action in this plan begins automatically.

## 5. Concrete regression assertions for the implementation handoff

The task-specific cases above are mandatory. These small Vitest assertions pin the central pure-function behavior; their input fixture names and expected results are defined in the audit contract and created by Tasks5/6. They are documentation examples, not tests already present or run.

```ts
import { expect, test } from 'vitest';
import { normalizeUrl } from '@lyraseo/visibility/url';
import { evaluateAudit, compareAudits } from '@lyraseo/visibility';
import { readFixture } from './fixtures';
// readFixture(name: string): AuditEvidence loads the named JSON fixture,
// validates it against the shared schema and throws on a missing/invalid file.

test('normalization preserves distinct page identity', () => {
  expect(normalizeUrl('https://EXAMPLE.com:443/a#part')).toBe('https://example.com/a');
  expect(normalizeUrl('https://example.com/a/')).not.toBe(normalizeUrl('https://example.com/a'));
});
test('unknown acquisition is not a measured failure', () => {
  const result = evaluateAudit(readFixture('timeout-not-404'));
  expect(result.rules.find(r => r.ruleId === 'D01')?.outcome).toBe('UNKNOWN');
  expect(result.score).toBeNull();
});
test('schema absence is not a penalty', () => {
  expect(evaluateAudit(readFixture('no-jsonld')).rules.find(r => r.ruleId === 'E05')?.outcome)
    .toBe('NOT_APPLICABLE');
});
test('removing a page cannot resolve its issue', () => {
  const before = evaluateAudit(readFixture('removed-page-before'));
  const after = evaluateAudit(readFixture('removed-page-after'));
  const delta = compareAudits(before, after);
  expect(delta.resolved).toHaveLength(0);
  expect(delta.unevaluated.length).toBeGreaterThan(0);
});
```

Task6 defines `AuditEvaluation` with `{score:number|null, rules:RuleResult[], manifest, methodologyVersion, profile}` and `AuditComparison` with `{resolved,new,persistent,improved,worsened,unevaluated,scoreDelta:number|null}` arrays as specified by the comparison contract. The two removed-page fixtures are the before/after pair for the named `removed-page-not-fixed` case. Export paths above become package exports in Task1/6; they are not existing imports.

For transactional tests, Task4's test harness creates two independent DB connections and starts admission simultaneously against the same seeded budget rows. Assert exactly one accepted operation, one outbox event and one reservation for the $0.40/$0.30 race. Replay its receipt twice and assert one settlement and the exact billed decimal. Do not simulate this invariant with an in-memory mutex or a mocked transaction.
