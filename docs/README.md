# LyraSEO AI documentation

This directory owns LyraSEO AI product planning. Continue development in `/Users/defiankit/Desktop/lyraseo-ai`.

The [consolidated planning review](./product-quality-and-optimization.md#8-consolidated-planning-review) records the 2026-10-23 final consistency review, corrected contradictions, remaining founder choices and engineering/provider verification work. The stack is settled; phase-one local implementation was authorized on 2026-10-23 and is in progress. See [implementation progress](./evidence/phase-one-progress.md). Phase two and paid upgrades remain deferred. [Remaining decisions](./product-quality-and-optimization.md#83-what-remains-to-finalize-later) are deferred until the founder resumes; [engineering contracts](./product-quality-and-optimization.md#84-engineering-specification-finalized) are tracked separately.

## Engineering handoff

- [Current build roadmap](./build-roadmap.md) — approved private-pilot milestones, hosted OpenSEO breadth and verification gates.

- [Private-pilot authentication and ledger setup](./runbooks/private-pilot-auth.md) — implemented local boundaries, dedicated role configuration and unverified live acceptance.

- [Finalized engineering contracts](./engineering-contracts.md) — runtime, identity/tenancy, API/jobs/cost, integrations, privacy/recovery and UI states.
- [Audit and measurement contracts](./audit-and-measurement-contracts.md) — exact rules, fixtures, score/coverage and visibility formulas.
- [Implementation plan](./superpowers/plans/2026-10-23-lyraseo-implementation.md) — sixteen tasks with file/interface ownership, tests, dependencies and estimates. Planning only; business choices remain deferred.

## Product requirements

- [Final Solid logo and usage](./logo-direction-options.md) — final LyraSEO AI logo explicitly approved, with balanced AEO/GEO lettering inside every L symbol and all icon variants.

- [Typography, tokens and themes](./design-tokens-and-themes.md) — approved Manrope/Inter pairing, semantic values and fixed-marketing/app-Light-Dark-System theme scope.

- [Launch Review design brief](./launch-review-design-brief.md) — selected identity, refined landing-page and desktop/mobile app concepts, with refined direction approved.

- [Product context for design](../PRODUCT.md) — confirmed founder-first audience, product truth, constraints and approved brand context for Impeccable.

- [Release phases and internal administration](./release-phases.md) — approved private-testing boundary, lean admin and complete module split: customer automation/advanced administration deferred, other four feature groups retained in phase 1, earlier auth/PostHog decisions preserved.
- [Approved data retention and deletion policy](./data-retention-and-deletion.md) — category-specific retention, saved-work protection, deletion timing, backup rollover, required-record exceptions and processor limits. Founder-approved defaults; implementation and processor/statutory verification remain.
- [Approved stack and full-version specification](./full-version-spec.md) — approved decisions, proposed full-release features, module contracts, operating defaults, acceptance gates, and remaining founder decisions. Read this first for current scope.
- [Product quality and optimization review](./product-quality-and-optimization.md) — final planning findings, provider responsibilities, premium UI/UX direction, performance targets, DX, and remaining release decisions.
- [AI model policy](./ai-model-policy.md) — approved Azure OpenAI provider and two-model set, simple SDK configuration, proposed routing, pricing checks and observation boundaries.
- [Usage and cost policy](./usage-and-cost-policy.md) — approved $10 per user combined monthly testing-consumption budget and 25 Azure OpenAI API observations per user/month, with budget-based content/research/helper usage and internal retry/settlement controls; no additional monthly feature quotas.
- [LyraSEO AI PRD](./lyraseo-ai-prd.md) — positioning, free-to-paid journey, deterministic audit methodology, functional requirements, architecture, commercial model, delivery stages, and acceptance criteria.

The approved core stack is Next.js/React on Vercel, Tailwind/shadcn, Prisma, dedicated Supabase PostgreSQL, Cloudflare Workers/Queues, private R2, Cloudflare Browser Run, Parallel.ai, and DataForSEO. Phase 1 is private testing with Supabase Auth; Better Auth with Prisma must be ready in phase 2 before the first customer production launch. No customer launch on Supabase Auth followed by a planned live migration is selected. Prisma remains selected instead of Drizzle. Begin Browser Run on Workers Free and move to Workers Paid when approved capacity requires it. The selling business is in India and serves India and international customers using Razorpay and Polar respectively. AI visibility includes official API observations and actual consumer-app observations through DataForSEO; Azure Sol API plus consumer ChatGPT/Gemini and the English/India initial pilot are approved; exact provider configuration remains to verify. Parallel supplies cited research, not proof of consumer-app visibility.

LLM calls use Azure AI Foundry / Azure OpenAI exclusively, with `gpt-6.1-sol` for substantive generation and `gpt-6-luna` for bounded helpers. Plan one independent LyraSEO AI Azure resource, two deployments and the standard OpenAI SDK pointed at Azure; no extra gateway, agent framework or automatic provider fallback. Actual deployment access, region, pricing and web-search support are setup checks. API observations are labelled Azure OpenAI and kept separate from DataForSEO consumer observations. All seven optimization recommendations remain approved.

Brevo remains selected for phase-two transactional email. Approved order: private phase 1 on a Vercel-provided address, acquire/confirm `lyraseoai.com`, then build phase 2 with verified Brevo sending, Better Auth, PostHog and the deferred customer automation/advanced admin. Dedicated Gmail SMTP is approved for phase-one email OTP and necessary transactional messages, alongside Google sign-in. Verify the account/credentials and delivery during setup. In-app status and scoped invitations remain part of private testing; Supabase owns auth codes. See [release execution order](./release-phases.md#11-approved-execution-order-domain-before-phase-2).

PostHog product analytics and dedicated error monitoring are deferred to phase 2. PostHog remains selected, with EU hosting and the approved allowlist/privacy constraints on activation. No phase-one PostHog ingestion is selected. Basic redacted platform logs, operation/failure records, billing/usage receipts and safety controls remain operational requirements.

Initial testing has an approved $10 per user combined monthly Azure OpenAI/Parallel/DataForSEO consumption budget and 25 API plus 200 consumer observations per user/month, with approved $8 Azure / $1 Parallel / $1 DataForSEO sublimits. Supabase Free is approved for initial testing and Pro for production. Other pilot quantities remain proposals, budget-gated. Free-first private testing is approved: $0 paid infrastructure initially, local development first after build authorization, and no paid upgrades/add-ons/deposits without explicit approval. Hosted-testing eligibility and production spending remain separate decisions; no purchase starts during planning.

Private phase-one testing and the lean internal admin panel are approved. Only customer automation and advanced administration from the six proposed cut groups move to phase 2; agency features, external integrations including GSC, advanced content/Parallel research and measurement expansion remain in phase 1. Earlier phase-two PostHog and Better-Auth-before-customer-launch decisions remain. Staff permissions/MFA and the approved product security policy still apply. The phase split and pilot observation allowances are settled. Engineering contracts and the implementation plan are finalized; public prices, production spending and phase-two activation details remain deferred. The consolidated review separates these gates.

Better Auth cutover is approved to preserve private-test accounts and product data with stable ownership and usage history, requiring fresh sign-in. MFA stays enforced; engineering handles verified re-enrollment if required.

Retention/deletion defaults are approved: short-lived full-source artifacts, 13-month compact history, saved-work protection, a seven-day active-store deletion target and separate backup/processor/legal boundaries. See the approved policy for exact categories and verification gates.

Impeccable is selected for landing-page and application design. The [UI/UX requirements](./product-quality-and-optimization.md#3-premium-ui-and-interaction-direction) cover responsive behavior, visual craft, motion, evidence, accessibility and bounded visual verification. Launch Review and the refined landing/app direction are approved; exact fonts, tokens and theme scope are also approved. No UI implementation has begun.

The founder is approved as the initial human operator for release approval, support and exceptional recovery; engineering prepares procedures and verification. The approved private-pilot recovery objective is recorded in [release phases](./release-phases.md#5-approved-initial-operator-and-pilot-recovery): restore within 24 hours of a confirmed incident, with up to 24 hours of recent test changes lost under successful daily backups and seven daily restore points. Engineering verifies the target; production objectives are finalized in phase 2.

## Commercial planning status

Solo, Team and Agency are approved as the phase-two public plan families, with the same core audit/AI quality and differences in capacity and collaboration needs. Prices, allowances, billing cadence and commercial terms will be finalized later. Keep phase-one testing private/free, the approved $10 per user monthly provider budget and the free-first/no-paid-upgrades-without-approval policy. This decision does not authorize application building.

## Selected domains

The founder selected a Vercel-provided `.vercel.app` address for initial setup/private testing and `lyraseoai.com` for the eventual production domain. The exact Vercel hostname is assigned at setup; `lyraseoai.vercel.app` is a preferred example, not a reserved address. Acquire/confirm production domain ownership before phase-two implementation; DNS and sender verification are phase-two setup checks. Approved URL layout: phase 1 uses `/` for marketing, `/app` for the customer app and `/admin` for staff on the assigned `.vercel.app` hostname. In phase 2, use `lyraseoai.com` for marketing, `app.lyraseoai.com` for the customer app and `app.lyraseoai.com/admin` for staff. Retain one codebase and one Vercel project with explicit host routing. No purchase or deployment is authorized. The hostname choice does not authorize Vercel Pro or establish Hobby eligibility; the existing free-first hosting policy remains.

## Project boundary

LyraSEO AI has its own accounts, database, billing, workers, storage, secrets, and deployments. References to LyraShield are historical background only. They do not authorize changes to it or establish shared identity, subscriptions, queues, databases, infrastructure services, or runtime dependencies on its checkout.
