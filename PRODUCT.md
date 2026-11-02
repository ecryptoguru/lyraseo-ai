# Product

<!-- impeccable:product-schema 1 -->

## Current implementation status

Phase-one local building was authorized on 2026-10-23. The approved stack/design/phase boundaries remain. Local UI and deterministic fixture behavior are under development; cloud/provider and authenticated acceptance remain separate. See [progress](docs/evidence/phase-one-progress.md). Earlier planning-only statements record the pre-authorization baseline; phase two and paid changes remain unauthorized.

## Platform

web

## Stack

Approved: Next.js/React on Vercel, Tailwind CSS and shadcn/ui, TypeScript, Prisma and dedicated Supabase PostgreSQL; Cloudflare Workers/Queues, R2 and Browser Run. Supabase Auth is for private phase 1; Better Auth is required before customer launch. Azure OpenAI supplies the two selected LLM models; Parallel Search/Extract provides research and DataForSEO provides consumer-app observations. Dedicated Gmail SMTP handles phase-one email; Brevo handles phase-two transactional email after domain acquisition; Razorpay and Polar are selected for billing. PostHog is deferred to phase 2.

## Users

Confirmed by the founder on 2026-10-22: founder-first, agencies secondary. The primary customer is a SaaS founder or small product team with a public marketing website, limited SEO expertise and the ability to publish improvements. Developers and small agencies are secondary users. Agency portfolios, scoped client access and branded reports remain in scope; audience priority does not remove those features.

## Product Purpose

Help users understand whether search and answer engines can discover and interpret their public website, identify actionable improvements and inspect changes over time. Connect evidence-backed audits, editorial assistance, research, search performance and AI visibility without blending their different kinds of evidence.

## Positioning

Evidence accompanies issues and recommendations. Deterministic readiness results are separate from API observations and actual consumer-app observations. Coverage, acquisition dates and methodology versions explain what a result can establish. Product differentiation must be demonstrated; no guaranteed rankings, AI inclusion or traffic growth is claimed.

## Operating Context

The intended public journey is URL preview, account, site audit, prioritized fixes, changes published by the user, rerun and comparison. Private phase 1 is invite-only testing, with sandbox billing. Public acquisition and pricing activation follow the release plan. The app supports repeated site work, evidence inspection, editable content and agency/client workflows. English-first remains the documented proposal.

## Capabilities and Constraints

LyraSEO AI is independent from LyraShield: accounts, identities, database, billing, workers, storage, secrets and deployment authority are separate. Customer automation and advanced administration are deferred to phase 2, alongside earlier Better Auth/PostHog timing decisions. The newer decision defers Brevo delivery/sender setup to phase 2 and requires acquiring `lyraseoai.com` before phase-two implementation. Private phase 1 uses Supabase Google sign-in plus email OTP through the approved dedicated Gmail SMTP account; phase 2 switches delivery to Brevo with Better Auth after domain acquisition. The $10 per user monthly combined Azure/Parallel/DataForSEO consumption ceiling with $8 Azure / $1 Parallel / $1 DataForSEO sublimits, 25 API and 200 consumer observations per user/month is approved; editorial/research/helper work uses remaining provider budget without separate monthly feature quotas. Free-first private testing is approved with $0 paid infrastructure initially and local development first after build authorization. No paid upgrades, add-ons or deposits without explicit founder approval; no automatic Vercel Pro purchase.

Planning only: do not scaffold, build or provision the application until explicitly authorized. Preserve the approved session, recovery, retention and deletion policies. Azure OpenAI Sol API plus DataForSEO consumer ChatGPT/Gemini, English and India, are approved for the initial pilot. Actual profile settings require verification; public pricing, remaining allowances, eligible hosted testing and production infrastructure ceiling remain open.

The Better Auth cutover must preserve private-test accounts, retained product data, stable product-user IDs, ownership and budget history. Require fresh sign-in; retain MFA protection with verified re-enrollment if necessary. Engineering handles mapping and rollback; no reset is selected. Existing retention/deletion rules continue.

Approved initial operator: the founder is the human owner for release approval, support and exceptional account-recovery decisions. Engineering prepares the procedures, verification and release evidence. Staff access is explicitly provisioned with the approved MFA/authorization rules; this assignment does not itself execute a deployment, recovery or account change. The private-pilot recovery target is approved: restore usable service within 24 hours of a confirmed incident, accepting up to 24 hours of recent test changes lost under successful daily encrypted backups and retaining seven daily restore points. Verify through a restore exercise; production targets are finalized in phase 2.

Solo, Team and Agency are approved as the phase-two public plan families, with the same core audit/AI quality and differences in capacity and collaboration needs. Prices, allowances, billing cadence and commercial terms will be finalized later. Keep phase-one testing private/free, the approved $10 per user monthly provider budget and the free-first/no-paid-upgrades-without-approval policy. This decision does not authorize application building.

## Brand Commitments

Approved display name and exact logo capitalization: **LyraSEO AI**. The founder requires fluid, premium, modern landing pages and application UX using Impeccable. The identity must be independent of LyraShield. The founder selected Launch Review on 2026-10-22: a cobalt, white and graphite identity, confident sans typography and evidence-to-action presentation. Marketing can use broad cobalt surfaces; the app uses restrained accents and quiet reading surfaces. The founder approved the final balanced logo on 2026-10-22. Option A — Solid is finalized as an outlined Manrope LyraSEO AI wordmark plus compact L symbol, with light/dark and monochrome assets. AEO is embedded in the vertical stroke and GEO in the horizontal foot of every L symbol, including compact logos, app icons and favicons. No plain-symbol fallback is selected. See docs/logo-direction-options.md; the selected future production domain is `lyraseoai.com`, with a Vercel-provided `.vercel.app` address for initial testing. Manrope headings, Inter UI/body text, system monospace, the semantic token baseline and theme scope are approved. The founder also approved the refined landing, desktop app and mobile direction. The approved specification is docs/design-tokens-and-themes.md: fixed cobalt/white marketing; Light/Dark/System throughout the app, with System default; white reports/PDFs. Approval does not authorize implementation.

Approved URL layout: phase 1 uses `/` for marketing, `/app` for the customer app and `/admin` for staff on the assigned `.vercel.app` hostname. In phase 2, use `lyraseoai.com` for marketing, `app.lyraseoai.com` for the customer app and `app.lyraseoai.com/admin` for staff. Retain one codebase and one Vercel project with explicit host routing.

## Evidence on Hand

The repository contains product and design planning documents under docs/. An initial local product UI now exists, using clearly labelled synthetic fixtures. Launch Review is the selected visual direction; illustrative generated mockups are stored under .impeccable/mocks/launch-review/. No customer testimonials, customer logos, live performance results or finished product screenshots are supplied in this workspace. Demonstrations must be labelled illustrative where users could mistake them for real results.

## Product Principles

- Make the next useful action clear to a founder without specialist SEO knowledge.
- Keep evidence, uncertainty, scope and freshness visible.
- Preserve authored work and explain costs before admitting paid work.
- Support agency depth without making the founder's default journey unnecessarily dense.
- Treat responsive behavior, accessibility and recoverable states as product quality requirements.

## Accessibility & Inclusion

Planning requirements include keyboard access, visible focus, labelled controls, accessible chart alternatives, contrast, zoom/reflow, reduced motion and usable touch targets. Responsive web covers phones, tablets and desktop. These are requirements, not verified conformance claims.

## Planning Authorities

[PRD](docs/lyraseo-ai-prd.md) owns product requirements and methodology. [Full-version specification](docs/full-version-spec.md) owns the selected stack and decision register. [Release phases](docs/release-phases.md) owns timing. [Quality review](docs/product-quality-and-optimization.md) owns proposed UI/UX and performance requirements. [Model policy](docs/ai-model-policy.md), [usage policy](docs/usage-and-cost-policy.md) and [retention policy](docs/data-retention-and-deletion.md) retain their detailed contracts. This product record supplies design context without replacing those authorities.

Engineering handoff finalized on 2026-10-23: [contracts](docs/engineering-contracts.md), [audit/measurement definitions](docs/audit-and-measurement-contracts.md) and [implementation plan](docs/superpowers/plans/2026-10-23-lyraseo-implementation.md). Business decisions remain deferred; explicit build authorization and provider verification are still required.
