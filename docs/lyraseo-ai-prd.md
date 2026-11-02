# LyraSEO AI — Product Requirements Document

Version: 2.8 · Date: 2026-10-23 · Status: private phase 1, lean admin and selective phase split approved; Azure OpenAI and retention/deletion defaults approved; engineering contracts finalized; business choices and provider verification deferred


Approved free-first testing: $0 paid infrastructure initially, local development first after build authorization, plus the existing $10 per user/month combined Azure OpenAI/Parallel/DataForSEO consumption cap. No paid upgrades, add-ons or deposits without explicit approval. Supabase Pro remains the production direction, with paid activation still requiring approval. See [usage policy](./usage-and-cost-policy.md#7-approved-free-first-testing-policy).
Owner: founder/product, with engineering, design, and growth collaborators.

This document defines the LyraSEO AI product. [Release phases](./release-phases.md) owns current delivery timing and supersedes earlier single-release commitments in this PRD. [The full-version specification](./full-version-spec.md) owns stack selection, eventual feature contracts and remaining decisions; this PRD owns audit methodology and core requirements unless amended there. None establishes implementation, deployment, approved prices, trademark clearance or a purchased domain. Planning continues in `Desktop/lyraseo-ai/docs` before application implementation.

## 1. Product decision and executive summary

LyraSEO AI helps founders and small teams understand whether search and answer engines can discover and interpret their public website, identify concrete improvements, and measure changes over time.

The product combines evidence-backed readiness audits, editorial assistance/research, GSC performance, AI visibility, competitor comparisons and agency/integration workflows in private phase 1. The founder deferred only customer automation and advanced administration from the proposed cut groups. Supabase Auth remains for private testing; Better Auth must be ready before customer launch, and PostHog remains in phase 2. Exact evidence, metrics and operating behavior are defined in the engineering contracts; live provider support and commercial limits remain unverified/deferred.

The customer journey is:

```text
Public URL → Free page preview → Account → Full site audit
           → Prioritized fixes → Publish changes → Re-audit → Compare
```

The approved direction is a fully independent customer-facing product developed in `Desktop/lyraseo-ai`. LyraSEO AI owns its accounts, database, billing, workers, storage, secrets, deployments, onboarding, navigation, data model, entitlements, and usage. Reviewed patterns may be copied and maintained locally. No shared LyraShield identity, database, queue authority, billing service, or runtime source dependency is planned.

Launch decisions carried forward:

- Offer a useful free preview and a paid full audit.
- Limit the launch full audit to 25 public same-origin pages.
- Use a deterministic, versioned audit engine.
- Use Cloudflare Browser Run for rendered acquisition, initially on Workers Free and later Workers Paid; production acceptance still requires feasibility evidence.
- Use Next.js/React on Vercel, Tailwind/shadcn, Prisma, dedicated Supabase PostgreSQL, dedicated Cloudflare Workers/Queues and private R2. Supabase Auth is limited to private phase-one testing; Better Auth with Prisma must be ready before the first customer launch. Prisma remains selected instead of Drizzle.
- Use Google sign-in plus email OTP through approved dedicated Gmail SMTP in private phase 1. The eventual login scope remains Google plus email OTP with optional authenticator-app TOTP; once enrolled, require MFA after either login method. Full-version section 11.5 owns the approved 30-day maximum session, seven-day refresh inactivity, 15-minute JWT, ten-minute sensitive-action authentication, OTP limits and backup-TOTP/reviewed recovery policy with a minimum 72-hour hold after accepted verification.
- Use Supabase Free for initial controlled testing and Pro for the production database; Supabase-native auth controls apply only while that auth provider is used. Optional compute/add-ons and the infrastructure ceiling remain to finalize; no provisioning starts during planning.
- Keep opt-in model-assisted remediation and former post-MVP modules in the eventual product contract; phase assignment follows the release-phase document.
- Serve India and international customers from an Indian business, using Razorpay and Polar respectively.
- Use Parallel.ai for cited research and supporting content evidence, within its approved provider budget and bounded engineering execution limits.
- Include both official API observations and actual consumer-app visibility through a supported external measurement provider; do not merge their metrics or silently substitute one for the other.
- Initial pilot surfaces are approved: Azure OpenAI Sol API, DataForSEO consumer ChatGPT and consumer Gemini, in English with India as the target market. Verify supported provider controls and data-use contracts; 25 API and 200 consumer observations are approved per user/month within the $8/$1/$1 split; other quantities remain proposed.
- Use Azure AI Foundry / Azure OpenAI with only `gpt-6.1-sol` and `gpt-6-luna` for LLM calls; Claude, direct Gemini, direct Perplexity and Astra are not selected.
- Apply all seven approved optimization recommendations recorded in the quality review.
- Use the Impeccable design workflow for fluid, premium, modern landing pages and application experiences. Launch Review and the refined landing/app direction are approved, along with Manrope headings, Inter UI/body, system monospace, semantic tokens and fixed-marketing/app-Light-Dark-System theme scope in the design specification.
- Limit initial Azure OpenAI/Parallel/DataForSEO consumption to $10 per user combined per month and initial observations to 25 Azure API plus 200 consumer observations per user/month, within $8 Azure / $1 Parallel / $1 DataForSEO sublimits.
- Use Brevo for transactional email in phase 2 after domain acquisition; sender/account acceptance and free-tier branding are verified before customer launch. Acquire/confirm `lyraseoai.com` after private phase 1 and before phase-two implementation. Dedicated Gmail SMTP is approved for phase-one auth and necessary transactional email.
- Defer PostHog product analytics and dedicated error-monitoring integration to phase 2. EU hosting and approved allowlist/privacy constraints apply on activation. Keep phase-one redacted platform logs, job/failure records, billing/usage receipts and operational controls; no PostHog ingestion or new monitoring vendor in phase 1.
- Use approved Mumbai primary Supabase/Vercel regions and a best-effort R2 APAC hint, with global processing boundaries as recorded in full-version section 11.6.
- Include the approved lean phase-one staff admin: user/workspace/site support, jobs, usage/spend views, sandbox billing, recovery/privacy cases, pause controls and audit trail, with separate staff grants and mandatory staff MFA.
- Keep security findings, security scores, scan minutes, and assurance reports outside LyraSEO AI's domain model.

## 2. Problem, audience, and positioning

### 2.1 Problem

Small teams can publish websites quickly but often cannot answer practical questions: Can crawlers reach the useful pages? Is the important content available in the returned page? Are canonical and indexing directives consistent? Does a page clearly answer a buyer's question? What should be fixed first, and did the change resolve the issue?

Existing workflows combine generic SEO checklists, manually inspected robots files, screenshots of AI answers, and untraceable recommendations. A single score often hides missing coverage or mixes observable facts with subjective judgments.

### 2.2 Primary customer

Founder confirmed on 2026-10-22: founder-first, agencies secondary. This priority governs landing-page messaging and the app’s default information density; agency features remain included.

An early-stage SaaS founder or small product team with a public marketing website, limited SEO expertise, and the ability to publish changes. The initial customer manages one company site and wants actionable results without operating a large SEO suite.

Secondary customers are developers helping launch a site and small agencies auditing client sites. The full-release proposal includes portfolios, site-scoped client access, branded reports, and bounded batch admission with independent per-site jobs.

The initial product is English-first. Unsupported or uncertain language-dependent checks must be marked unevaluated rather than failed. Technical checks can run independently of language.

### 2.3 Positioning

Proposed promise: **Understand your site's search readiness, fix the highest-priority issues, and track what improved.**

Differentiators to prove through the product:

- Evidence attached to each issue, including page, observation, and acquisition time.
- Clear separation between measured readiness and observed search/AI visibility.
- Reproducible scoring with visible coverage and methodology versions.
- Practical fixes linked to a rerun that establishes whether the original issue remains.
- A useful public result before account creation.

Do not claim guaranteed rankings, inclusion in AI answers, traffic growth, factual accuracy of all content, or a proprietary score validated against business outcomes without evidence.

### 2.4 Jobs to be done

| User job                       | Product response                     | Evidence of success                                            |
| ------------------------------ | ------------------------------------ | -------------------------------------------------------------- |
| Check a recently launched site | Free homepage preview                | User receives useful findings without signup                   |
| Understand site-wide issues    | Bounded multi-page audit             | Findings have page-level evidence and coverage                 |
| Decide what to fix first       | Prioritized action list              | User can identify an actionable next step                      |
| Prove a fix worked             | Rerun and matched comparison         | Original rule is reevaluated on comparable content             |
| Explain results to a teammate  | Private downloadable report          | Scope, evidence, and limitations remain intact                 |
| Improve a weak page            | Opt-in editorial assistant           | Suggestions cite the page evidence and need approval           |
| Measure actual discovery       | GSC and AI observation modules       | Metrics retain their source, time window, and sampling context |

## 3. Product boundaries and scope

### 3.1 Eventual product scope and phase assignment

The phase-one scope retains preview, accounts/workspaces, site verification/discovery, audits, issues, reports, reruns/comparisons, quotas and operational safeguards, plus editorial assistance/briefs, Parallel research, GSC, manual AI observations, advanced competitor views, agency/client workflows, branding and bounded external integrations. The lean operator admin is approved and distinct from customer workspace administration. Customer schedules/advanced notifications and advanced operator administration remain deferred; the later sender decision also places Brevo delivery in phase 2 after domain acquisition. Earlier auth/PostHog decisions apply. See release-phases.md for the approved FULL-module mapping; no other feature group is cut.

The proposed boundary excludes a proprietary keyword/backlink index, general SERP rank tracking, authenticated-page crawling, desktop clients, autonomous website changes, and in-house consumer answer-engine scraping. Actual consumer-app observations are required through a supported external measurement provider. CMS integration means reviewed export and draft handoff; automatic publishing requires a separate explicit decision. Full version does not imply every feature of a conventional SEO suite.

A readiness audit is a sampled technical/content assessment. It is not an SEO traffic forecast or a measurement of how often an AI system currently recommends the business.

### 3.2 Eventual module responsibilities

| Module | Full-release responsibility | Entry condition before development/external execution |
| ------ | --------------------------- | ------------------------------------------------------ |
| Readiness | Deterministic preview and verified-site audit | Reviewed rule contracts and acquisition feasibility |
| Content | Editorial review, rewrites, content briefs | Model/provider approval, grounding evaluations, cost limits |
| Search | Search Console metrics | Read-only OAuth, property mapping, retention contract |
| Automation | Scheduled audits, observations, and alerts | Explicit opt-in, allowance accounting, durable scheduling |
| Visibility | Prompt panels, citations, mentions, competitors, locale/language metadata | Approved acquisition surfaces, provider terms, sampling and budget |
| Collaboration | Teams, portfolios, client access, branded reports, bounded integrations | Role/site isolation and reviewed integration contracts |

These modules retain their eventual contracts. Apply acceptance gates when a module ships in its approved phase; do not treat deferred PostHog as a phase-one gate or silently defer other modules without founder approval. Unavailable providers for an included phase remain unresolved gates.

## 4. Experience and navigation

### 4.1 Public experience

The LyraSEO AI landing page offers one URL input with an example and a short explanation of scope. The free result is available before email capture. Its conversion funnel, accounts, and analytics are independent of LyraShield.

The preview includes the submitted page, origin robots policy, sitemap discovery, score eligibility, category observations, top three actionable issues, passed checks, and coverage limitations. Sitemap discovery does not imply every sitemap URL was audited.

The primary CTA is “Audit more pages.” Preserve the submitted URL through signup, but require the authenticated user to confirm the site and full-audit scope. Do not silently start paid work.

### 4.2 Authenticated navigation

Use Overview, Sites, Audits, Issues, Content, Search Performance, Visibility, Reports, and Settings. Place billing, team membership, integrations, schedules, and notification preferences under Settings or their relevant site context. Keep the primary navigation compact with contextual site navigation. Empty modules explain how to connect or configure them.

Overview shows the next useful action, latest comparable readiness result, coverage, unresolved high-priority issues, and recent changes. Empty state starts with adding a site; it must not show a perfect score or artificial example progress.

### 4.3 Core journey

1. User submits a public page and receives a preview.
2. User creates an account and workspace.
3. User confirms the site origin and verifies control using DNS TXT or a hosted verification file.
4. User selects up to 25 discovered pages and confirms the audit allowance.
5. Audit progresses through acquisition and evaluation with truthful counts.
6. Results explain coverage, score, issues, evidence, and recommended actions.
7. User applies changes externally and requests a rerun.
8. Comparison distinguishes resolved, persistent, new, and unevaluated issues.

Support direct signup without using the public preview.

### 4.4 Required UI states

Every run surface supports queued, acquiring, evaluating, completed, partial, failed, cancelled, and expired-artifact states. Cancellation may take time to stop remote work; show “Cancellation requested” until acknowledged.

Reports must work on mobile and desktop, support keyboard navigation and accessible focus, and never rely on color alone. Target WCAG 2.2 AA for shipped interactions. Present evidence progressively so founders can act without reading raw HTML.

## 5. Functional requirements

### 5.1 Public preview

| ID     | Requirement                              | Acceptance criterion                                                                                |
| ------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| PRE-01 | Accept one public HTTPS URL              | Invalid schemes, credentials, private targets, and malformed inputs are rejected before acquisition |
| PRE-02 | Return meaningful results without signup | Results include scope, at least applicable observations, and clear errors when unavailable          |
| PRE-03 | Bound anonymous consumption              | Global, client, and target limits prevent unbounded browser work                                    |
| PRE-04 | Explain limited coverage                 | Page score is never labelled site score                                                             |
| PRE-05 | Avoid retaining public input content     | Raw content is ephemeral; cached normalized results expire after 24 hours                           |
| PRE-06 | Keep results private by capability       | Unguessable result token; no indexable result route or public listing                               |
| PRE-07 | Match paid methodology                   | Identical snapshots and rule versions produce identical page outcomes                               |

Initial anti-abuse defaults: three uncached previews per client per day, one active preview per client, and ten uncached previews per origin per day. Use a rotating keyed hash for client rate-limit identifiers, with no raw IP in product analytics. A global daily browser-spend cap is mandatory. Tune these limits from pilot evidence.

The 24-hour result cache contains normalized findings and safe excerpts only. URLs with credential-like or sensitive query values must be rejected from anonymous preview. User-controlled path and query data must not enter analytics.

### 5.2 Sites and full audits

| ID     | Requirement                                  | Acceptance criterion                                                             |
| ------ | -------------------------------------------- | -------------------------------------------------------------------------------- |
| AUD-01 | Persist a verified site origin per workspace | Verification cannot grant access to unrelated subdomains or origins              |
| AUD-02 | Let users review discovered pages            | User sees the final page manifest before starting the audit                      |
| AUD-03 | Enforce 25-page maximum                      | Acquisition and evaluator independently enforce the limit                        |
| AUD-04 | Run asynchronously                           | Refreshing the page does not lose the run; lifecycle survives worker restart     |
| AUD-05 | Preserve immutable results                   | Every completed result binds content hashes, rule version, scope, and timestamps |
| AUD-06 | Handle incomplete acquisition                | Missing pages/checks remain unknown and lower reported coverage                  |
| AUD-07 | Cancel safely                                | Cancellation stops new work and cannot publish a misleading completed score      |
| AUD-08 | Reuse completed results                      | Downloads and navigation do not trigger browser/model work                       |
| AUD-09 | Compare reruns                               | Deltas identify scope/rules changes and compare only compatible observations     |
| AUD-10 | Export a private report                      | Export includes scope, acquisition time, evidence, methodology, and limitations  |

Default page candidates: submitted homepage, then sitemap-discovered same-origin HTML pages, then same-origin links discovered from the homepage. Normalize URLs, remove fragments, deduplicate, and sort stably. Exclude logout, account, checkout, search-result, and obvious non-content routes. Users can replace candidates before confirming the run.

Discovery itself is bounded: at most five sitemap documents, 1,000 candidate URLs, and a configured response-size/time budget. A sitemap index cannot cause unrestricted recursion. The final manifest is frozen before scoring; dropped URLs remain recorded as not acquired.

Allow one active full audit per site, with configurable workspace concurrency, initially one in free development mode and bounded by plan/provider capacity later. Reruns require a user action or an explicitly enabled schedule with an approved manifest and budget. Retry transient page acquisition at most twice within the run's fixed deadline. Queue retries resume idempotently and must not reserve another audit allowance.

### 5.3 Findings and remediation

Each issue includes stable rule ID, title, affected URL, observed value, expected condition, evidence excerpt, priority, fix guidance, relevant documentation, and evaluation timestamp. Evidence snippets must be escaped and never render arbitrary fetched HTML.

Priority combines a published rule priority with affected-page count and user-selected key pages. It is an action-ordering heuristic, not an estimate of ranking impact. Avoid invented percentages of expected traffic improvement.

Users can acknowledge or dismiss an issue with a reason. Workflow dismissal does not change the computed score. Only reevaluation can establish a technical issue is resolved.

### 5.4 History and comparison

Issue identity uses rule ID and normalized page URL. Compare outcomes only when the relevant rule is compatible. Display pages added/removed, acquisition failures, and rule-version changes beside deltas. A page disappearing from coverage never counts as an issue fixed.

Offer “rerun same scope” as the default. Refreshing page discovery is a distinct action that creates a new manifest.

## 6. Audit methodology and score integrity

### 6.1 Categories

| Category                      | Weight | Deterministic checks and observations                                                                                    |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| Discovery and eligibility     | 30     | HTTP success, robots policy, indexing directives, canonical consistency, sitemap membership, internal discovery          |
| Extractability and semantics  | 25     | Main content availability, title/headings, meaningful links, parseable structured data, raw/rendered content differences |
| Answer structure and evidence | 25     | Heading/section structure, lists/tables where present, attribution links, dates and authorship signals where applicable  |
| Entity and trust clarity      | 20     | Identifiable organization/product, contact/about links, consistent explicit identity fields, relevant policy links       |

Technical checks must distinguish observations from conclusions. A source link does not prove a claim is true. Schema presence does not establish correctness. A contact page does not prove trustworthiness. Deterministic “answer structure” checks measure formatting and explicit evidence signals; they do not judge whether prose fully answers a buyer's intent.

Rule applicability depends on declared page type where reliable. An anonymous landing page must not fail for lacking a scholarly bibliography, and a static page must not fail for lacking a publication date. Ambiguous applicability becomes unknown or informational.

### 6.2 Outcomes and scoring

Supported outcomes are PASS, WARNING, FAIL, NOT_APPLICABLE, and UNKNOWN. UNKNOWN represents missing, unreadable, unsupported, or unreliable inputs and must never be treated as PASS or NOT_APPLICABLE.

Each versioned scoring rule has an applicability predicate, positive weight, severity, evidence contract, and deterministic evaluator. Informational observations have zero score weight and are recorded separately. For eligible scoring, PASS earns 1, WARNING 0.5, and FAIL 0. NOT_APPLICABLE and UNKNOWN contribute no earned score; report their weights separately. The [audit and measurement contract](./audit-and-measurement-contracts.md) now fixes exact predicates, aggregation, category eligibility, fixtures and metric definitions.

Compute category results from weighted evaluated checks. Overall score is the weighted mean of applicable category results. Within each category, evidence coverage is evaluated applicable weight divided by evaluated plus unknown applicable weight. Overall coverage is the category-weighted average over active categories, as defined in the audit contract.

Publish a numeric score only when the homepage is acquired, at least 80% of selected pages are acquired, and at least 80% of applicable check weight is evaluated. Otherwise show “Insufficient coverage” with available findings. Scores are integer 0–100 rounded once after aggregation.

If a complete eligible sample is confirmed non-indexable, show readiness score 0 with the blocking eligibility explanation and other category observations. Do not apply this override when inaccessible pages make eligibility uncertain. A zero means measured failure; unavailable input receives no numeric score.

All rules and initial thresholds require evaluation on a reviewed fixture set before launch. The proposed weights are product heuristics, not empirically established ranking factors. Publish that distinction in the methodology page.

### 6.3 Crawler and rendering policy

Evaluate Googlebot, Bingbot, OAI-SearchBot, and PerplexityBot policy separately. Keep training crawlers such as GPTBot informational. Do not penalize a customer for choosing to block training access. `llms.txt` is an optional observation with zero score weight.

Retain raw HTML and rendered HTML observations where available. Do not infer accessibility to every crawler from successful browser rendering. A robots allowance indicates declared permission, not successful indexing or citation.

Acquire only under the service's declared identity and purpose. Never impersonate a blocked crawler to bypass access restrictions. Access denial is an observed result with clear limits.

## 7. Optional AI editorial review

This is an opt-in full-release capability. The founder approved Azure OpenAI in Foundry with only `gpt-6.1-sol` and `gpt-6-luna` for LLM calls. Use one independent resource, two deployments and the standard OpenAI SDK against Azure; keep configuration simple without an additional gateway or provider-routing layer. Proposed routing uses Sol for rewrites, briefs and complex explanations and Luna for bounded classification/tagging/extraction; see [the model policy](./ai-model-policy.md). The exact models are documented API identifiers; account access, processing terms, reasoning settings and budgets still require verification/finalization. Specify provider and grounding acceptance criteria before coding; run controlled evaluations after explicit build authorization and before enabling real use.

Input consists of a selected completed snapshot and deterministic findings. Output includes prioritized explanations, proposed answer-first sections, missing buyer questions, consistency concerns, and suggested rewrites. Each suggestion must identify its supporting page or clearly state that it is an editorial hypothesis.

Requirements:

- Explicit user action, allowance check, and content-processing disclosure.
- Fixed input/output limits, deadline, per-job spend cap, and cancellation behavior.
- Store model configuration, prompt version, input snapshot hash, and generation time.
- Apply existing normalization and prompt-injection controls; fetched content is untrusted data.
- No browsing tools, autonomous execution, publishing, or access to unrelated workspace content.
- Suggestions cannot modify deterministic rule outcomes or scores.
- Do not invent testimonials, statistics, citations, customers, product features, or credentials.
- User reviews and copies/exports proposed content; original site content remains unchanged.

Evaluate factual grounding, actionable usefulness, citation fidelity, and resistance to injected page instructions before launch. Private-pilot usage shows remaining provider budget without editorial credits or monthly content quotas. Public credit packaging remains undecided.

## 8. Observed visibility and SEO expansion

### 8.1 Search Console integration

Use explicit read-only OAuth access to selected properties. Show impressions, clicks, CTR, and average position with dates, property, filters, and source. Preserve source freshness delays. Do not attribute a traffic change to an audit fix solely because it occurred afterward.

Connection revocation stops new imports. Imported metrics have documented retention and deletion behavior. Access to a workspace is not equivalent to permission to every connected Google property.

### 8.2 AI-answer observation

Track user-approved prompts by engine, locale, language, execution time, model/version when exposed, retrieval mode, and repetition count. Save returned answers and citations under appropriate provider terms.

Distinguish brand mention, linked citation, recommendation, and answer availability. A missing or failed response is unavailable, not zero visibility. Match brand aliases and domains using explicit configuration and review ambiguous matches.

Display metrics over the sampled prompts and successful observations only, with denominators and coverage. Prompt-set changes create a new cohort. Avoid a universal “AI rank” across engines.

An API response may differ from the consumer product experience. Label the measured surface accurately. Do not claim ChatGPT consumer visibility when observing a different API pipeline. Supported acquisition and provider terms must be verified before committing to an engine.

The founder requires both official API observations and consumer-app observations and has selected DataForSEO for external measurement. Parallel.ai is approved for supporting research, but its Search/Extract outputs are not themselves consumer-app observations. Validate DataForSEO's exact surface coverage, evidence export, sampling/locality, permitted storage/resale, and unit economics before promising named consumer coverage. Keep API and consumer cohorts separate. The documented LLM Scraper covers ChatGPT and Gemini; a Perplexity LLM Responses endpoint is not evidence of consumer Perplexity coverage.

### 8.3 Full-release expansion

Competitor comparisons, content briefs, scheduled checks, change alerts, agency portfolios, and bounded integrations are part of the full-release proposal in [the full-version specification](./full-version-spec.md). Buying a keyword/backlink dataset remains a separate commercial decision; LyraSEO AI does not build a web-scale index for launch.

## 9. Architecture and integration boundaries

### 9.1 Proposed components

| Component                 | Responsibility                                                         |
| ------------------------- | ---------------------------------------------------------------------- |
| LyraSEO AI web surface       | Marketing, preview, onboarding, authenticated product                  |
| Visibility domain package | Typed contracts, rules, scoring, normalization, comparisons            |
| LyraSEO AI worker            | Discovery, acquisition, evaluation, report generation                  |
| Acquisition adapter       | Cloudflare implementation and explicit provider metadata               |
| Product persistence       | Sites, audits, manifests, issues, snapshots, entitlements              |
| Artifact storage          | Encrypted private snapshots and exports with retention                 |
| Product infrastructure    | Independent auth, UI, logging, queue, storage, and billing utilities |

Proposed app paths are `apps/lyraseo-web` and `apps/lyraseo-worker`; proposed shared package is `packages/visibility`. These are planning identifiers, not existing implementations or authorization to rename existing package scopes.

Supabase Auth/SSR is limited to private phase-one testing; Better Auth with Prisma is required before the first customer launch. Preserve private-test accounts/data with fresh sign-in as approved; resolve implementation mappings before coding, without assuming a live customer migration. Supabase owns its managed auth schema while used; Prisma owns product persistence and reviewed Better Auth tables under the phase-two contract. Brevo is deferred to phase 2, when Better Auth uses a reviewed server-side API callback. Phase-one Gmail custom SMTP is approved for Supabase email OTP and necessary transactional messages; Google sign-in remains available. Workspaces, memberships, invitations and site grants remain product-owned with stable identity mappings. Neither auth choice automatically authorizes direct Prisma queries. Full-version specification sections 11.4/11.5 retain the security policy; Supabase-specific JWT/timeout/factor checks must be mapped and verified for Better Auth. Free testing, Pro production database and full-version specification section 11.6 regions remain approved. Additional staging costs remain in the infrastructure budget review.

Use LyraSEO AI-owned Cloudflare queues, worker deployments, credentials, and capacity controls. PostgreSQL is authoritative for lifecycle and accounting; queue delivery is at least once. Audit admission uses a transactional outbox, durable leases, and idempotent settlement. No LyraShield queue authority or runtime service is used.

### 9.2 Acquisition

Cloudflare Browser Run is approved. Begin initial tests on Workers Free, with its account-wide browser allowance and request limits. Upgrade to Workers Paid when approved capacity or required functionality exceeds those limits; the upgrade is a deliberate operational action. Selection does not establish production suitability: verify rendered output, raw-response evidence, robots behavior, cancellation, retention, isolation, and costs using official documentation and an authorized corpus.

Use raw HTTP evidence and rendered HTML without provider AI extraction. Markdown is a derived convenience, never the sole technical evidence. Use bounded fetching for robots and sitemaps under the same network policy. Parallel.ai is approved for a separate cited research workflow with explicit freshness, provenance and budget; its extracted text does not establish raw HTML facts or deterministic audit outcomes. Firecrawl is not selected. Self-hosted browsers are outside the proposed full-release scope.

Preflight URL validation alone does not secure browser redirects or subresources. Production acceptance requires documented provider-side isolation or enforceable request policy for navigation, redirects, DNS resolution, and subresource traffic. Never assume a single DNS check is sufficient against rebinding.

Enforce network/time/response-size budgets, same-origin crawl scope, redirect bounds, content-type checks, and no user-supplied credentials or cookies. Treat every page and provider response as untrusted input.

### 9.3 Data model

| Proposed entity            | Required ownership and fields                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| VisibilitySite             | workspace, canonical origin, verification state/method/time, display name                                 |
| VisibilityAudit            | workspace, site, creator, sponsor account, status, idempotency key, rules version, scope hash, timestamps |
| VisibilityPageSnapshot     | audit, requested/final URL, status, headers subset, content hash, artifact reference, acquisition outcome |
| VisibilityIssue            | audit, rule ID/version, page key, outcome, priority, safe evidence, remediation                           |
| VisibilityResult           | immutable category scores, aggregate score or null, coverage, manifest/checksum, provider metadata        |
| VisibilityIssueAction      | workspace, issue identity, actor, disposition, reason, timestamp                                          |
| VisibilityUsageReservation | sponsor account, product entitlement, operation ID, units, reserved/settled/released state                |
| VisibilityEditorialReview  | snapshot hash, model/prompt version, output artifact, lifecycle and usage receipt                         |

Use Prisma-owned product cuid IDs, workspace scoping, explicit database roles, appropriate RLS and reviewed migrations including custom SQL where needed. The phase-one Supabase identity reference is its UUID `auth.users.id`; preserve managed auth objects. Preserve private-test accounts/data and stable product-user IDs through Better Auth cutover, require fresh sign-in and preserve budget/ownership continuity. Engineering resolves provider-identity/foreign-key mappings under release-phases.md; no automatic factor migration is assumed. Review user deletion against workspace ownership and financial retention. Use runtime-appropriate PostgreSQL drivers/pooling for Vercel/Cloudflare and a separate migration connection. Immutable results retain schema versions and checksums, with operational metadata stored separately. The eventual model extends to billing, schedules, content, integrations and observations in their approved phases.

Site scores must not enter LyraShield `ScoreSnapshot`, and readiness issues must not enter security `Finding`. LyraSEO AI reruns do not use security verification labels such as VERIFIED or VALIDATED.

### 9.4 API and lifecycle

Proposed product-local API prefix: `/api/v1/visibility`.

| Endpoint                             | Purpose                                            |
| ------------------------------------ | -------------------------------------------------- |
| `POST /previews`                     | Start bounded anonymous preview                    |
| `GET /previews/:token`               | Retrieve capability-bound normalized preview       |
| `POST /sites`                        | Create workspace site                              |
| `POST /sites/:id/verify`             | Verify control                                     |
| `POST /sites/:id/discover`           | Return bounded candidate manifest                  |
| `POST /audits`                       | Reserve allowance and enqueue confirmed manifest   |
| `GET /audits/:id`                    | Return lifecycle, coverage, and result             |
| `POST /audits/:id/cancel`            | Request idempotent cancellation                    |
| `POST /audits/:id/rerun`             | Create explicit new run with a new idempotency key |
| `GET /audits/:id/report`             | Retrieve authorized export                         |
| `POST /audits/:id/editorial-reviews` | Opt-in AI review                                   |

Full audit lifecycle: QUEUED → ACQUIRING → EVALUATING → COMPLETED or PARTIAL. FAILED and CANCELLED are terminal alternatives. Persist cancellation requests separately until execution acknowledges them. PARTIAL can have a numeric score only when the coverage threshold is met; always show its limitations.

Bind queued job IDs and payloads to persisted audit, workspace, sponsor, verified origin, manifest, and limits before execution. Idempotency, lease recovery, and usage settlement must survive duplicate deliveries and process crashes.

## 10. Commercial model and entitlements

Use independent LyraSEO AI accounts, subscriptions, and entitlements. The selling business is registered in India and serves Indian and international customers. Razorpay and Polar are approved billing providers; the proposed routing is Razorpay/INR for India and Polar/USD internationally. Currency and routing defaults still require final commercial review. Provider onboarding/eligibility is not established by this decision.

Proposed packaging:

| Offering                | Included capability                              | Proposed beta limit                             |
| ----------------------- | ------------------------------------------------ | ----------------------------------------------- |
| Free preview            | One-page readiness result                        | Anonymous limits in PRE-03                      |
| Internal pilot          | Controlled validation of the complete product   | One verified site, ten 25-page audits/month as initial test allowance |
| Solo / Team / Agency (approved) | Same core audits, content, search and visibility quality; capacity/collaboration packaging | Prices and exact commercial allowances remain open for later review |
| Public metering proposal | Audits, editorial work and AI observations | Credit packaging remains undecided; private-pilot generation/research uses provider budgets |

Solo, Team and Agency are the approved public plan families. Prices, currency, tax handling, trial policy, refunds and exact allowances remain open for later review and require approval before checkout launch. The one-site/ten-audit beta allowance is an unapproved proposal, not an instruction to impose new pilot quotas. Invite-only testing remains free; engineering capacity and abuse bounds still apply.

The [usage and cost policy](./usage-and-cost-policy.md) records the approved $10 per user combined monthly provider-consumption budget and 25 Azure OpenAI API observations per user/month for initial testing. Editorial, research and helper work uses remaining provider budget without additional monthly feature quotas. Token/time/retry bounds are engineering controls; public pricing and capacity contracts remain separate. The testing budget is separate from public plans, infrastructure costs and provider prepaid deposits; no implementation or provider calls begin while specification finalization is ongoing.

Do not consume security agent-minutes for deterministic audits. Reserve one audit credit on admission; settle when a usable completed or eligible partial report is available. Release the credit for platform failure, cancellation before usable output, or insufficient coverage. Anti-abuse limits still count attempted resource consumption. All settlement operations are idempotent and account-owned.

Build a LyraSEO AI-owned billing account and provider-price mapping. One active base subscription per billing account is enforced across both providers. Verify signed raw-body webhooks, deduplicate by provider/event ID, reconcile out-of-order delivery, and maintain an append-only accounting trail. Never grant paid access from a checkout redirect alone. Money uses exact minor units with currency or reviewed Decimal types; never floating-point amounts. Provider changes require an explicit migration to prevent double billing. Razorpay and Polar invoice/tax roles must remain accurately identified.

Track internal cost per preview, full audit, report, and editorial review. Include browser work, storage, model usage, retries, and support overhead. Set public prices only after measuring the distribution of costs and customer value; vendor free tiers are not a production unit-economics assumption.

## 11. Privacy, security, and retention

The founder approved the category schedule and deletion workflow in [the retention/deletion policy](./data-retention-and-deletion.md). They distinguish LyraSEO AI-held data, processor records, backups and required legal/security exceptions. Azure OpenAI processing follows Microsoft terms, rather than direct OpenAI account retention assumptions. No settings or real data were changed during planning.

- Anonymous raw page content is held only for processing; normalized preview results expire within 24 hours.
- Approved defaults: full raw page/research captures 30 days, raw AI observation answers 90 days, compact audit/observation/GSC history 13 months, deliberately saved briefs/drafts/reports while the workspace is active and seven-day download caches. These replace the blanket twelve-month proposal and protect saved customer work from silent expiry.
- Approved confirmed-deletion target: block access/new processing immediately and purge LyraSEO AI active stores within seven days. Seven-day rolling operator backup copies expire by their own creation date, potentially up to fourteen days from initial request; provider physical-copy erasure requires separate verification. No blanket thirty-day backup promise is selected.
- Keep required ICT/security records under the reviewed 180-day India archive baseline and necessary billing records under the applicable entity-specific statutory schedule. Routine debug detail is distinct; legal exceptions do not justify retaining page content or prompts. Verify applicability, field/system coverage and provider export/configuration before launch.
- After raw snapshot expiry, clearly identify which evidence remains and disable reproduction or AI review requiring deleted input.
- Encrypt private artifacts, use checksums, restrict signed URLs, and escape displayed content.
- Keep authorization workspace-bound and quota/ledger ownership account-bound.
- Exclude page content, query strings, IPs, credentials, and customer-authored text from analytics.
- Domain verification is required for full crawling and scheduled checks. Public preview remains passive and bounded. Competitor comparison uses prompt-observation evidence and approved limited public-page research; it does not authorize unverified full-site competitor crawling.
- Support verified-site removal and account deletion through a documented deletion workflow with an outbox for storage cleanup.
- Minimize operational logs and redact URLs where paths or queries may be sensitive.
- Provider retention is part of the privacy contract: local deletion alone cannot promise immediate deletion from third-party acquisition systems.

## 12. Success metrics and learning plan

Product analytics collection is phase 2. During private phase 1, evaluate reliability, quality and cost using the already-required operational receipts, controlled fixtures and manual research; do not add behavioral event capture or an analytics backlog to calculate the proposed funnels below. Observe activation/retention/conversion funnels only when their approved telemetry phase activates.

North-star candidate: **weekly workspaces that resolve at least one audited issue and confirm the change with a comparable rerun**. Treat this as a proposed product-value metric until research confirms it reflects customer success.

| Metric                 | Definition                                                                      |
| ---------------------- | ------------------------------------------------------------------------------- |
| Preview success        | Usable preview results / admitted preview attempts                              |
| Preview activation     | Workspaces starting a first full audit / unique users receiving preview results |
| Time to first value    | Time from admitted request to usable result, reported at p50/p95                |
| Full-audit reliability | Usable completed/eligible partial reports / admitted full audits                |
| Action rate            | Audited workspaces acknowledging or fixing an issue within seven days           |
| Confirmed improvement  | Workspaces with resolved comparable issues / workspaces rerunning               |
| Retention              | Activated workspaces returning for a meaningful audit action in week four       |
| Paid conversion        | Paying accounts / eligible activated accounts over a defined cohort window      |
| Unit economics         | Internal variable cost per usable result and per retained paying account        |
| Quality                | Human-reviewed rule precision and unknown/partial coverage rate                 |

Proposed pilot goals, not public claims: at least 90% usable results on authorized supported sites; p95 preview under 60 seconds and 25-page audit under five minutes; at least 95% precision for high-priority deterministic failures on a labelled corpus. Measure blocked sites separately rather than hiding them from overall attempts.

Proposed research cohort: 10–15 design partners with diverse site stacks. This is not an instruction to enroll funded pilot users; at the approved per-user cap, 10–15 admitted users represent up to $100–$150/month provider consumption. Confirm the intended pilot cohort before invitations. Inspect at least 30 authorized fixture sites across static, server-rendered, and JavaScript-heavy implementations. Evaluate whether users understand the findings and can implement a fix without assistance. Continue toward broad paid launch only after at least five partners confirm willingness to pay and acquisition cost is bounded. These are proposed decision gates, not market forecasts.

## 13. Delivery plan and effort

The founder now selects phase-two deferrals, superseding the earlier single full-product release requirement. The former 44–67 engineering-day deterministic-MVP estimate remains obsolete. A new estimate must use the finalized phase scope, admin panel and auth-transition boundary. The stages below describe dependency order for the eventual product, not a requirement to finish phase-two modules before a private phase-one test.

| Internal stage | Deliverable | Exit gate |
| -------------- | ----------- | --------- |
| 0 | Final specification and provider contracts | Relevant phase decisions recorded, rule/API contracts reviewed, budgets explicit; later public terms may remain deferred |
| 1 | Acquisition, auth/database, billing and AI feasibility tests | Compatible runtimes, evidence, isolation, access, costs and retention demonstrated |
| 2 | Rules engine and core product | Reproducible audits, tenant-safe lifecycle, reports and comparisons |
| 3 | Content, GSC, scheduling and visibility | Grounded outputs, OAuth revocation, reproducible panels, bounded recurring work |
| 4 | Collaboration, integrations and commerce | Client/site isolation, safe draft handoff, both billing-provider flows verified |
| 5 | Integrated pilot and complete release | All agreed module acceptance gates and operational recovery checks pass |

Map these dependency stages onto finalized release phases before implementation. Phase 1 stays private and uses sandbox billing; customer launch requires verified Better Auth, the approved security policy, relevant billing paths and operational readiness. Included modules must pass their gates; explicit deferrals do not authorize unrelated cuts. Provider feasibility tests begin after planning is finalized; no scaffolding or provisioning is authorized now.

## 14. Acceptance and release gates

### 14.1 Rules and evidence

- Same snapshot and rule version produce byte-equivalent normalized outcomes and score.
- Unknown input cannot improve coverage or appear as a pass.
- Non-indexable override requires complete supporting eligibility evidence.
- Score thresholds, rounding, applicability, and page aggregation have golden fixtures.
- Different page selection or rule versions cannot silently generate a claimed improvement.
- Reports retain source time, scope, limitations, and evidence after rendering/export.

- CSV export neutralizes spreadsheet formulas in untrusted cells; HTML/Markdown display and export are sanitized for their target context, and PDF rendering cannot fetch arbitrary resources from customer content.

### 14.2 Acquisition and abuse

- Test private addresses, IPv6, DNS changes, redirects, subresources, unsupported schemes, and large responses.
- Test JavaScript-heavy sites, blocked crawlers, robots conflicts, sitemap loops, duplicate URLs, and malformed HTML.
- Verify global browser caps, per-origin limits, deadlines, provider outages, cancellation, and retry bounds.
- Prove that LyraSEO AI preview load is isolated from paid work and no sibling-product queue, credentials, or service is required.

### 14.3 Tenancy, lifecycle, and commerce

- Cross-workspace site/audit/report access is denied.
- Queued payload tampering cannot change the persisted owner, sponsor, origin, or manifest.
- Duplicate delivery and crash recovery do not duplicate audit credits or external work without bounds.
- Platform failure releases allowance once; usable results settle once.
- Subscription changes and webhook replay preserve correct independent product entitlements.
- Deletion completes storage cleanup and leaves only permitted retention records.

### 14.4 UX and operations

- Test mobile/desktop, keyboard/screen-reader basics, loading, empty, partial, failure, and cancellation states.
- Verify no public analytics payload includes content, full target URLs, or raw network identifiers.
- Alerts cover queue age, failed acquisition, browser spend, missing artifacts, and settlement discrepancies.
- Document provider outage behavior, worker drain/restart, data backup/restore, and emergency preview disablement.
- Run relevant raw lint, typecheck, unit/integration/E2E, build, formatting, migration, and security checks before release.
- Retain deployment revision and controlled end-to-end proof separately from source completion.

### 14.5 Full-version modules

- Verify grounding, unsupported-claim handling, prompt-injection resistance, cancellation, and exactly-once credit settlement for editorial jobs.
- Verify GSC property permissions, date/dimension aggregation, incomplete data, token expiry, revocation, and deletion.
- Verify schedules across timezone/DST changes, duplicate ticks, missed ticks, insufficient allowance, expired verification, and outages.
- Verify AI observations retain provider/surface, prompt cohort, repetition, locale support, citations, failure denominators, and cost receipts.
- Verify competitor alias ambiguity and domain matching; never present failed observations as zero visibility.
- Verify every role/site grant, invitation expiry, last-owner protection, and client access to reports without unrelated data.
- Verify integration revocation, destination isolation, signed webhook replay, and CMS draft-only behavior. Reconcile uncertain CMS write acceptance before retrying so a timeout cannot silently create duplicate drafts.
- Verify Razorpay and Polar checkout, renewal, failure, cancellation, refunds/disputes, replay and cross-provider duplicate-subscription prevention.

## 15. Risks, tradeoffs, and open decisions

| Risk                                     | Impact                       | Response                                                              |
| ---------------------------------------- | ---------------------------- | --------------------------------------------------------------------- |
| Readiness mistaken for actual visibility | Misleading product value     | Separate readiness from measured search/AI observations throughout UI |
| Generic checklist scoring                | Weak willingness to pay      | Validate concrete fixes and rerun value with design partners          |
| Public crawler abuse                     | Cost and availability        | Multi-level limits, global cap, ephemeral results, kill switch        |
| Provider coverage or policy changes      | Failed audits                | Adapter boundary, corpus evaluation, explicit partial outcomes        |
| Broad full-release scope                 | Longer delivery and integration risk | Freeze bounded module contracts and verify in internal stages |
| Accidental sibling-product coupling      | Independent operation fails  | Own identity, database, billing, queues, secrets and deployments |
| Poor model suggestions                   | Trust loss                   | Grounded input, evaluations, visible editorial status and human review |
| Name/domain availability                 | Rebranding or launch delay   | Founder clearance before public launch                                |

Founder decisions still required: prices/checkout policy, transactional sender identity, production infrastructure spending and production recovery objectives. The private-pilot recovery target is approved: restore within 24 hours of a confirmed incident, with up to 24 hours of recent test changes lost under successful daily backups and seven daily restore points. The founder is approved as initial operator for releases, support and exceptional recovery; engineering prepares procedures and verification. Observation allowances, budgets and private-test preservation are approved; provider verification and runtime/auth mapping are engineering work. The feature split is approved: only customer automation and advanced administration are newly deferred, while agency, integrations, content/research and measurement stay in private phase 1. Earlier Better Auth-before-customer-launch and PostHog phase-two decisions remain. Engineering contracts and the task-based implementation plan are now finalized; explicit build authorization and later phase-specific business/provider gates remain.

Approved decisions: independent LyraSEO AI; Prisma/Supabase PostgreSQL; Free testing/Pro production database; Google/email OTP, optional customer TOTP and reviewed security policy; mandatory staff MFA for the lean admin; Browser Run Free initially/Paid later; approved Mumbai/R2/PostHog locations; Brevo, Parallel, DataForSEO, the two selected OpenAI models through Azure Foundry and Razorpay/Polar; approved retention/deletion defaults. Private phase 1 includes agency, integrations, advanced content/research and measurement features. Customer automation and advanced administration are deferred, alongside earlier phase-two PostHog and Better Auth-before-customer-launch decisions. Engineering behavior is finalized in the linked contracts; commercial limits remain deferred and release-phases.md owns timing.

## 16. References and provenance

- [Current LyraShield PRD](../../lyrashield-ai/PRD.md): sibling-project background on existing product boundaries and commercial foundation; not a LyraSEO AI runtime dependency.
- [LyraShield architecture map](../../lyrashield-ai/codebase.md): sibling-project reuse candidates; source must be inspected before integration.
- [LyraShield product context](../../lyrashield-ai/PRODUCT.md): sibling-project release-assurance audience and positioning.
- [Google AI features and your website](https://developers.google.com/search/docs/appearance/ai-features): search eligibility and content fundamentals.
- [OpenAI crawler documentation](https://developers.openai.com/api/docs/bots): crawler purposes and controls.
- [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/): approved acquisition provider; suitability and costs still require controlled verification.
- [Semrush AI visibility features](https://www.semrush.com/kb/1626-ai-visibility-features): competitive scope reference.
- [Ahrefs Brand Radar documentation](https://help.ahrefs.com/en/collections/12501057-brand-radar): competitive scope reference.

This specification carries forward the free-to-paid and deterministic-methodology choices from the earlier AEO/GEO discussion. The 2026-10-22 founder decisions replace shared-platform assumptions and the MVP-first delivery model. Sibling-project references are historical context only; vendor quotas and prices from older discussions are not current facts.

Brand identity: Option A — Solid is approved and finalized as the LyraSEO AI wordmark and compact L, with AEO/GEO lettering embedded inside the L symbol. See [logo assets and usage](./logo-direction-options.md).
