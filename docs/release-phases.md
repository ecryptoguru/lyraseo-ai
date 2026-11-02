# LyraSEO AI: release phases and internal administration

Updated: 2026-10-22. Status: private phase 1 and lean admin approved. Of the six additional cut groups, only customer automation and advanced administration move to phase 2; the other four remain in phase 1. Earlier Better Auth/PostHog phase decisions remain approved. The newer domain/email decision moves Brevo sender setup/delivery to phase 2 after acquiring the domain; dedicated Gmail SMTP is now approved for private phase-one email. Engineering contracts and the implementation plan are finalized; business choices remain deferred and building is not authorized.


Approved free-first testing: $0 paid infrastructure initially, local development first after build authorization, plus the existing $10 per user/month combined Azure OpenAI/Parallel/DataForSEO consumption cap. No paid upgrades, add-ons or deposits without explicit approval. Supabase Pro remains the production direction, with paid activation still requiring approval. See [usage policy](./usage-and-cost-policy.md#7-approved-free-first-testing-policy).
## 1. Current decisions and authority

This document owns phase assignment and supersedes the earlier requirement to ship every full-version module in one release. The full-version specification and PRD still describe the eventual product and its module contracts; they do not make every module a phase-one commitment. Do not remove additional features merely because they appear as deferral candidates here.

The founder approved the region selection: primary Supabase database in Mumbai `ap-south-1`, Vercel database-dependent functions in Mumbai `bom1`, R2 `apac` as a best-effort location hint, global Cloudflare execution, and PostHog EU/Frankfurt when activated. This is not an India-only processing guarantee.

## 1.1 Approved execution order: domain before phase 2

1. **Private phase 1:** after separate build authorization, develop/test on the planned Vercel-provided `.vercel.app` address when eligible hosting is available, with local-first development and the existing free-first/provider budgets. Supabase Auth supplies Google sign-in plus email OTP delivered through the approved dedicated Gmail SMTP account, with the approved TOTP/session controls. Verify SMTP account eligibility and delivery before enabling email login; no Brevo or custom-domain DNS is required in this phase.
2. **Before phase-two implementation:** acquire or confirm control of `lyraseoai.com`. Domain cost/ownership and any hosting upgrade remain explicit setup decisions; this written plan does not purchase anything. Do not wait until after phase-two development or public launch to obtain the domain.
3. **Phase 2:** configure the domain and verified Brevo sender; switch transactional email and email OTP delivery to Brevo with the selected Better Auth/Prisma production identity, then complete PostHog, customer automation and advanced administration. Preserve private-test accounts/data, budget attribution and MFA; require fresh sign-in at cutover. Public/live activation follows acceptance, not merely domain registration.

Approved URL layout: phase 1 uses `/` for marketing, `/app` for the customer app and `/admin` for staff on the assigned `.vercel.app` hostname. In phase 2, use `lyraseoai.com` for marketing, `app.lyraseoai.com` for the customer app and `app.lyraseoai.com/admin` for staff. Retain one codebase and one Vercel project with explicit host routing. Acquire the domain before phase-two implementation; verify app-host auth and API routing before public launch.

The founder approved dedicated Gmail SMTP for phase 1 and Brevo for phase 2 after domain acquisition on 2026-10-22. Phase-one Google and email-OTP sign-in are both in scope. Supabase issues/verifies auth codes; Gmail only transports them. Use TLS, an eligible Google App Password with 2-Step Verification and the actual Gmail From address. Use the same approved sender for necessary private-test invitations/transactional messages through server-only sending code; in-app status remains available. No Brevo fallback or second active sender is required. Sender credentials, runtime connectivity and delivery are setup checks, not another provider-selection vote. Do not bypass MFA or claim email/recovery notices were delivered before verified delivery. Existing recovery rules and the minimum hold remain unchanged.

The founder requested these phase changes:

| Item | Current disposition |
| ---- | ------------------- |
| Product analytics | PostHog remains selected; SDK ingestion, funnels and analytics configuration move to phase 2 |
| Dedicated monitoring | PostHog Error Tracking and its source-map/alerting integration move to phase 2; no replacement monitoring vendor is added |
| Production auth target | Better Auth with Prisma is approved for phase 2 and must be ready before the first customer production launch; Supabase Auth is limited to phase-one private testing |
| Supabase plans | Free for initial controlled testing and Pro for the production database remain approved; Better Auth does not replace Supabase PostgreSQL |
| Auth transition boundary | Approved: phase 1 stays private; complete and verify Better Auth before the first customer launch; no customer launch on Supabase Auth followed by a planned live migration |
| Internal admin panel | Approved for private phase 1: bounded user/workspace/site support, job controls, usage/spend views, sandbox billing status, recovery/privacy cases, pause controls and audit trail; separate staff grants and mandatory staff MFA |
| Domain and transactional email | Acquire/confirm `lyraseoai.com` before phase-two implementation; Gmail SMTP and email OTP are approved for phase 1; Brevo sender/DNS setup and migration of delivery belong to phase 2 |
| Additional phase-two cuts | Customer automation and advanced administration only; agency features, external integrations, advanced content and measurement expansion remain in private phase 1 within the existing product boundary |

Basic platform logs, persisted operation/failure states, accounting receipts, billing-webhook processing, authorization audit records and budget/queue safeguards are necessary operational controls rather than PostHog analytics. Keep their existing privacy and access restrictions. These remain required in phase 1 while the dedicated telemetry product is deferred. No PostHog events/exceptions are transported in phase 1, and no customer analytics backlog is collected for future ingestion.

## 2. Approved auth transition and remaining implementation contracts

The founder approved private phase-one testing with Better Auth ready before the first customer production launch. Keep test deployments and access private/invite-only; no public self-service customer launch or live customer billing in phase 1. Billing may use provider sandboxes. Founder-approved cutover policy: preserve private-test accounts and product data, and require a fresh sign-in when moving to Better Auth. Keep stable LyraSEO AI user identities, workspace ownership/memberships, sites, audits, drafts, reports, history and usage/budget attribution. Do not reset data or grant a new allowance merely because the auth provider changes. Preserve Google sign-in and MFA protection; add/retain email OTP under the sender timing above; use verified MFA re-enrollment if factors cannot safely transfer. Existing retention/deletion policies still apply; preservation does not extend expired or deleted data. This boundary does not need repeat approval. Production still requires the final security, billing and operational acceptance gates.

Initial hosted testing uses the selected Vercel-provided `.vercel.app` address when eligible hosting is available; `lyraseoai.com` is the intended eventual production domain. Hostname selection does not change the approved private-testing gate or authorize paid hosting.

Private access must include the preview route, signup, APIs and artifacts. Define narrowly reachable OAuth callback and signed provider-webhook routes so deployment protection does not break integrations; validate OAuth state/PKCE or webhook signatures before accepting work. Test invitations against an explicit allowlist. Private hosting still needs an eligible Vercel commercial plan; it does not imply Hobby eligibility.

Better Auth's official Supabase migration guide states that active sessions are invalidated and its example does not cover MFA or RLS migration. It is not a guaranteed drop-in switch. Before implementation, resolve identity/account mappings, product user and foreign-key continuity, Google identity linking, workspace ownership, MFA secrets or verified re-enrollment, recovery, session revocation, cutover and rollback. Preserve the approved Google/email-OTP login and optional authenticator MFA; do not introduce passwords because a migration example uses them. No silent disabling of enrolled MFA.

The approved user-facing session policy remains 30 days maximum, seven-day inactivity semantics, recent authentication for sensitive actions and the reviewed recovery procedure. Its Supabase-specific JWT, refresh-inactivity, live-session and backup-factor details describe the phase-one provider. Better Auth uses a different session contract: re-specify and verify equivalent server-side expiry/inactivity/revocation and recovery enforcement before production; do not assume a 15-minute Supabase access JWT becomes a Better Auth session lifetime. Brevo integration is deferred until phase 2, where Better Auth sends through its reviewed Brevo API/server callback. Supabase custom SMTP uses the approved dedicated Gmail account in phase 1. Do not provision both as concurrently active production identity authorities.

Current Better Auth guidance does not automatically challenge Google OAuth or email-OTP sign-in for MFA. Passwordless factor enrollment alone does not enforce the second factor. Production acceptance must prove server-side gating after both approved login methods, including admin access. The Admin plugin provides auth-management APIs; it does not supply a complete LyraSEO AI operations UI or product authorization model. Provider-native backup codes or a different recovery method require review against the approved recovery policy rather than an automatic scope change.

Sources checked on 2026-10-22: [Supabase migration guide](https://better-auth.com/docs/guides/supabase-migration-guide), [Better Auth MFA](https://better-auth.com/docs/plugins/2fa) and [Admin plugin](https://better-auth.com/docs/plugins/admin). Better Auth documentation was cross-checked through Context7. No migration, schema changes, provider calls or deployment occurred.

## 3. Approved phase-one internal admin panel

The founder approved a small `/admin` area within the planned Next.js application, using the same domain services and Prisma contracts. This is the LyraSEO AI operator console, distinct from the customer workspace Admin role. Do not add a second application, generic admin framework, direct SQL console or parallel billing system. The scope below is approved for private phase-one testing; implementation is still gated on final planning.

| Area | Approved phase-one scope |
| ---- | ------------------------ |
| Users/workspaces/sites | Search and inspect identities, membership, verification and suspension status; display only the information needed for support |
| Jobs | Inspect status, safe failure code and provider receipt references; cancel/pause; retry only recoverable failures through the normal idempotent admission path |
| Usage and spend | View allowance, reservations, settlements, provider consumption, spend ceilings and quota-paused states; no ad hoc balance editing |
| Billing | View reconciled sandbox subscription/provider state; inspect failed webhooks and request safe reconciliation; production billing activation is phase 2 and refunds/charge changes remain in provider consoles initially |
| Recovery/privacy cases | Track verification, hold deadlines, notices, operator decision and cleanup state; panel access does not authorize bypassing MFA, deleting data or approving a case without the runbook |
| Operational controls | Pause previews, crawling, generation, observation dispatch or schedules; no browser-editable provider secrets or uncontrolled budget increases |
| Admin audit trail | Record operator, action, target, reason, time and outcome; actions stay attributable and do not rewrite historical accounting |

Require an explicitly provisioned staff grant plus mandatory MFA and fresh authentication for mutations. Customer MFA remains optional as approved; customer owners/admins do not inherit staff access. Never promote the first signup or trust a browser-supplied role/email flag. Enforce access on the server for every admin API and action; hiding navigation is not authorization. Read-only is the default. Customer content access needs separate case-specific authorization; no impersonation or unrestricted cross-workspace browsing in the initial panel. Secrets, full prompts/page text and payment data are excluded from routine views. Bound pagination, exports and retry actions. Any future credit-adjustment feature must use reasoned, attributable ledger entries rather than overwriting balances; it is not part of the initial view-only usage scope. Basic kill switches and accounting/recovery runbooks remain required. The lean admin scope does not need repeat approval.

## 4. Approved feature split

The founder selected only customer automation and advanced administration from the six proposed deferral groups. The four other groups remain in private phase 1. This supersedes the previous six-group recommendation and does not need another approval. Existing provider restrictions, cost/usage limits, verified surface coverage and explicit product exclusions still apply; retaining a feature group does not approve unlimited execution or unspecified providers.

| Feature group | Approved phase | Boundary |
| ------------- | -------------- | -------- |
| Agency features | Private phase 1 | Client portal, report branding, portfolios and bounded multi-site actions with site-scoped roles; no custom-domain portals or cross-workspace pooled wallets |
| External integrations | Private phase 1 | GSC, WordPress draft handoff, signed outbound customer webhooks and scoped public read-only API tokens; private/test access, explicit manual actions and no autonomous publishing |
| Advanced content | Private phase 1 | Long briefs, Parallel Search/Extract research, cross-page strategy and factual structured-data drafts, alongside page rewrites; explicit user initiation and spend/grounding controls |
| Customer automation | Phase 2 | All customer daily/weekly audit and observation schedules, regression/digest alerts and advanced notification preferences; manual runs and in-app status stay in phase 1; necessary transactional email uses Gmail SMTP in phase 1; Brevo replaces it in phase 2 |
| Measurement features | Private phase 1 | Planned supported engine/locale/repetition coverage, advanced competitor views, share-of-voice trends and portfolio comparisons; the three pilot surfaces and English/India are approved; exact supported settings remain DEC-02 verification, samples/limits stay bounded and insufficient history remains visible |
| Advanced administration | Phase 2 | Impersonation, configurable staff role builders, custom refund/credit UIs, bulk account operations and advanced operator/business dashboards; the approved lean admin stays in phase 1 |

PostHog analytics/monitoring and Better Auth before customer launch are already assigned to phase 2 and do not need another vote. Moving public customer access and live billing activation to phase 2 follows the approved private-testing boundary; sandbox integration/entitlement tests stay in phase 1. Additional direct AI providers, proprietary keyword/backlink indexes, general SERP tracking, autonomous publishing and other explicitly excluded capabilities are not silently added to phase 2.

### 4.1 Module mapping for the approved split

The following maps all FULL modules to the approved feature timing. Module contracts, provider feasibility and exact allowances still need finalization; this mapping does not authorize implementation or account changes.

| Module | Approved private phase 1 | Phase 2 / production work |
| ------ | ------------------------ | ------------------------- |
| FULL-01 Preview | Protected test deployment exercising the useful one-page preview and abuse limits | Public availability after customer-launch gates |
| FULL-02 Accounts | Supabase Auth; Google sign-in plus email OTP through Gmail SMTP; optional customer TOTP, mandatory staff MFA; memberships/site grants and session/recovery checks supported by the testing plan | After domain acquisition: Better Auth, Brevo/email OTP and reviewed identity/session/MFA/recovery mapping before customer launch; verify full production policy |
| FULL-03 Sites | Verification, bounded discovery, manifests and multi-site portfolios under private pilot allowances | Finalized commercial site allowances and production capacity |
| FULL-04 Audits | Versioned deterministic audits up to 25 public same-origin pages, evidence, score and coverage | Production capacity validation and later rule additions through versioned contracts |
| FULL-05 Issues | Findings, dispositions, assignments, agency/portfolio views, same-scope reruns and compatible deltas | Production acceptance of the included workflows |
| FULL-06 Reports | Standard and agency-branded private PDF/CSV, with site-scoped client portal access | Public customer availability after launch gates |
| FULL-07 Editorial | Grounded explanations, bounded page rewrites, title/description suggestions, cross-page work and factual structured-data drafts | Production quality/capacity acceptance |
| FULL-08 Briefs/research | Manual briefs, Parallel Search/Extract research, evidence snapshots and long-form strategy within approved spend | Production quality/capacity acceptance; customer recurring dispatch belongs to phase 2 |
| FULL-09 GSC | Read-only OAuth/property connection, imports, metrics and comparative views with private/test access | Public availability after OAuth/provider launch gates |
| FULL-10 Schedules/alerts | Manual product jobs, in-app status and necessary transactional email through Gmail SMTP; retain internal dispatch/retries/cleanup/budget controls; Brevo delivery deferred | Verified transactional email, customer schedules, regression/digest alerts and advanced preferences |
| FULL-11 Visibility | Manual API and consumer observations, supported profile/locale/repetition coverage subject to DEC-02, separate denominators, panels, evidence/history and comparison views within budget | Customer scheduled observation runs and production capacity |
| FULL-12 Competitors | Configured-brand matching, competitor dashboards, share-of-voice trends and portfolio benchmarks from compatible evidence; do not issue a separate request per competitor | Scheduled refresh and public customer availability |
| FULL-13 Agency/team | Team/site permissions, agency portfolios, client workflows, branded reports and bounded batch actions | Public customer availability and commercial plan activation |
| FULL-14 Integrations | Internal APIs, exports, GSC, WordPress drafts, signed outbound customer webhooks and public API tokens restricted to private testers | Public customer access and customer-triggered recurring automation |
| FULL-15 Billing | Razorpay/Polar sandbox flows, verified callbacks, subscription/entitlement state and usage reservation/settlement | Live customer checkout, finalized public plans and provider-console finance workflows |
| FULL-16 Operations | Approved lean admin, redacted platform logs, failure records, pause controls, accounting, deletion and recovery foundations | Production acceptance/restore/recovery drills plus advanced admin; PostHog separately activates in phase 2 |

Phase-one navigation includes GSC, content/research, agency/client and integration capabilities retained above. Do not add customer-scheduling or advanced-admin screens before phase 2, or dead-end upgrade buttons in private testing. Internal job queues, outbox delivery, provider polling, integration callbacks, bounded webhook retries, cleanup and spend safeguards remain phase-one infrastructure; these are not deferred customer automation. Use explicit actions and private/test connections for external writes. Only instantiate the contracts/tables actually needed by included modules. A missing optional provider credential must produce an actionable unavailable state rather than breaking unrelated core journeys.

This keeps phase 1 broad and changes the earlier lean-scope recommendation. Do not estimate it as the reduced six-group proposal. Phase 1 needs access-control, integration/OAuth, billing/settlement, grounding, failure-handling and deletion/recovery tests for included modules. Production drills repeat and extend that evidence against the final provider/configuration; deferring production acceptance does not defer correctness checks.

The recommendation is to preserve the core loop: preview, account, verify site, bounded audit, evidence-backed issues, useful fixes, rerun/compare, standard report and bounded AI visibility. Keep tenant authorization, SSRF protection, domain verification, rate limits, durable jobs, spend/credit accounting, deletion and the internal operational controls. Customer production launch also requires the selected billing paths and final production auth; private testing may use sandbox billing. Premium UX, accessibility, loading/error states and mobile behavior remain quality requirements in both phases.

The feature groups above remain approved; the later domain/email decision defers Brevo delivery while Gmail SMTP supports phase-one email as described in section 1.1. Engineering contracts and the planned recovery procedure are written; implementation and restore evidence are still required after authorization; observation allowances and the pilot recovery target are approved. Public prices, production infrastructure spending and production recovery objectives remain later phase-two decisions. Re-estimate against this broader phase-one scope. The approved $10 per user consumption budget and 25 Azure OpenAI API observations per user/month do not change; 200 consumer observations per user/month and the $8/$1/$1 split are approved; other pilot quantities remain proposals. Keeping more features does not authorize more live-provider spending or guarantee that all proposed maxima fit the budget.

The founder approved [the retention/deletion policy](./data-retention-and-deletion.md). Daily expiry/deletion reconciliation, restore-time deletion replay and required security-record collection are phase-one operational work; customer automation and PostHog remain in phase 2. Account settings, statutory applicability and system coverage remain verification gates, rather than another approval of the defaults. Azure OpenAI in Foundry is the selected LLM provider in both phases, with one independent resource/two deployments and no additional provider-routing framework; the provider change does not alter feature timing or increase the testing budget.

## 5. Approved initial operator and pilot recovery

Approved initial operator: the founder is the human owner for release approval, support and exceptional account-recovery decisions. Engineering prepares the procedures, verification and release evidence. Staff access is explicitly provisioned with the approved MFA/authorization rules; this assignment does not itself execute a deployment, recovery or account change.

Founder-approved private-pilot recovery objective (2026-10-22): restore usable service within 24 hours of a confirmed incident, using the approved daily encrypted backups and seven-day rolling history. With successful daily backups, up to 24 hours of recent test changes may be lost. These are internal pilot objectives to verify in a restore exercise, not a public availability guarantee or proof that free-tier recovery is already configured. Confirm production recovery and billing/usage reconciliation requirements in phase 2 before live customer launch.

## 6. Approved public plan families; remaining decisions deferred

Solo, Team and Agency are approved as the phase-two public plan families, with the same core audit/AI quality and differences in capacity and collaboration needs. Prices, allowances, billing cadence and commercial terms will be finalized later. Keep phase-one testing private/free, the approved $10 per user monthly provider budget and the free-first/no-paid-upgrades-without-approval policy. This decision does not authorize application building. No new planning question is required until the founder resumes the remaining decisions.

Engineering handoff: [finalized contracts](./engineering-contracts.md), [audit/measurement definitions](./audit-and-measurement-contracts.md), and [implementation plan](./superpowers/plans/2026-10-23-lyraseo-implementation.md). The plan preserves this phase mapping and defers business decisions to their activation gates.
