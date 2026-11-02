# LyraSEO AI: product quality and optimization review

Date: 2026-10-22 · Status: seven optimization recommendations approved; planning review only, with no implementation or performance measurements yet.

The founder requires efficient execution and premium, modern UI/UX/DX. The [full-version specification](./full-version-spec.md) records approved vendors and proposed feature contracts; the [PRD](./lyraseo-ai-prd.md) records audit methodology. Recommendations below refine those contracts without authorizing application implementation or paid provisioning.

[Release phases](./release-phases.md) owns the approved timing: private phase 1 retains agency, external integrations/GSC, advanced content/research and measurement features with the lean admin. Only customer automation and advanced administration are newly deferred; earlier Better Auth-before-customer-launch and PostHog decisions remain. Engineering contracts are finalized; commercial allowances remain open; do not estimate against the rejected six-group lean proposal.

The founder approved all seven recommendations: acquire once and reuse evidence; deliberate research; asynchronous DataForSEO Standard tasks; separate usage meters; a cohesive premium workspace; measurable performance; and a simple maintainable implementation. Detailed operating thresholds, visual variants and commercial limits remain proposals. The approved LLM provider is Azure OpenAI in Foundry with `gpt-6.1-sol` and `gpt-6-luna`; see [the model policy](./ai-model-policy.md).

## 1. Final planning findings

| Finding | Resolution / recommendation | State |
| ------- | --------------------------- | ----- |
| Release scope changed | Approved selective split: only customer automation/advanced administration newly deferred; four other feature groups retained in private phase 1 | Phase assignment and engineering contracts recorded; provider verification remains |
| Shared LyraShield assumptions conflicted with independence | Own accounts, database, queues, billing, secrets and deployments | Documentation corrected |
| Parallel research could be mistaken for crawl or measurement evidence | Browser Run acquires site evidence; Parallel supplies cited research; DataForSEO supplies consumer observations | Roles recorded; provider tests remain |
| API and consumer measurement were ambiguous | Both are approved; retain distinct cohorts and source labels | Documentation corrected |
| DataForSEO surface coverage could be overstated | Documented consumer scraper coverage is ChatGPT/Gemini; Perplexity Responses is a separate API surface | Three pilot surfaces approved; actual provider settings need verification |
| Free Browser Run could be read as a production capacity promise | Free initial tests; bounded admission, clear capacity states and explicit paid upgrade decision | Policy recorded; measured capacity remains unknown |
| Workspace-wide serialization would constrain agency use | One active audit per site with bounded configurable workspace concurrency | Selected execution bound recorded |
| Former delivery estimate omitted most full-version work | Supersede MVP estimate; estimate only after scope and provider feasibility | Documentation corrected |
| Premium quality lacked acceptance criteria | Screen/state, accessibility, responsiveness, performance and developer workflow proposals below | Approved direction and written state contracts; rendered verification remains |
| Commercial limits and model settings remain open | OpenAI model set is approved; keep routing/limits and prices explicit in the decision register | Public prices remain deferred; runtime/tariff verification remains |

This is a document and architecture review. It does not establish provider access, consumer-scraping authorization, correct implementation, achieved latency, or production readiness.

## 2. Provider responsibilities and cost boundaries

| Work | Primary service | Efficient default |
| ---- | --------------- | ----------------- |
| Site HTML/rendering and audit evidence | Cloudflare Browser Run plus safely bounded raw HTTP | One acquisition per selected page/run; preserve evidence and evaluate locally |
| Source research and brief context | Parallel.ai Search/Extract | Bounded excerpts first; explicit freshness and workspace cache; Task/Responses generation is not selected |
| Consumer ChatGPT/Gemini observations | DataForSEO LLM Scraper | Standard asynchronous tasks for manual phase-one runs and later schedules; Live requires an explicit permitted action |
| Official API observations | Azure OpenAI Responses; exact deployment/search profile pending | One request per approved prompt/surface/locale/repetition; no consumer equivalence claim |
| Grounded editorial generation | Azure OpenAI GPT-6.1 Sol and GPT-6 Luna | Selected immutable input; task-appropriate routing; fixed output and spend limits; no recursive autonomous tool loop |
| Reports | Stored results and a server-side PDF renderer | Cache exports by result, report-template version and branding; avoid additional page crawling |

Parallel is an approved dependency, but research need not run during every audit. Keep pure audit acquisition/evaluation independent of research and editorial requests. Display the approved observation counters and remaining provider budgets. Track audit/editorial/research costs internally without introducing new pilot feature quotas.

DataForSEO's documented scraper versus Responses products are different acquisition surfaces. Persist method and surface rather than inferring it from the vendor name. Treat upstream charge receipts as exact accounting inputs after safe numeric parsing, not JavaScript floating-point ledger values. Capture charges for failed attempts separately from customer credit settlement.

The Azure OpenAI-only LLM choice supersedes the direct OpenAI endpoint assumption and earlier five-surface proposal. Keep one resource, two deployments and one SDK client; no extra gateway or agent service. Approved pilot matrix: Azure OpenAI Sol API and DataForSEO consumer ChatGPT/Gemini, English/India; concrete provider configuration still needs verification. Approved testing limits remain $10 per user combined consumption/month and 25 Azure OpenAI API observations per user/month. With 25 prompts, the proposed manually initiated cadence is one API round/month and four weekly consumer rounds/surface: 225 observations, including 200 approved consumer results per user/month. This is not phase-one automated scheduling. Keep denominators visible; a fifth round or extra locale/repetition requires allowance/budget. Consumer Gemini measurement does not require a direct Gemini API integration.

Vendor free allowances are not a basis for promised customer credits. Set per-job caps and approved account/month spend limits before live provider work; browser/abuse daily limits remain separate, and no smaller daily AI budget has been approved. Preserve vendor processing and failure receipts. Do not add a second crawler, vector database, dedicated search cluster, Redis or a generic agent framework without a measured requirement.

## 3. Premium UI and interaction direction

Update 2026-10-22: the founder selected **Launch Review**. The [design brief](./launch-review-design-brief.md) records the cobalt/white/graphite direction and refined landing/app concepts. This supersedes the earlier open-ended visual-world proposals below; refined compositions, exact tokens, fonts and theme scope are now approved in [the design specification](./design-tokens-and-themes.md). No implementation is authorized.

Founder requirement: use the Impeccable design workflow for both landing pages and the application, with a fluid, premium and modern experience. Launch Review, Manrope/Inter, semantic tokens and theme scope are now explicitly approved; no additional animation library is selected. Implementation remains on hold. The selected skill is `/Users/defiankit/.agents/skills/impeccable/SKILL.md`. PRODUCT.md and the approved design specifications now provide planning context; no implemented UI or implementation-derived DESIGN.md exists.

### Design workflow and surface requirements

Product context, founder-first audience, Launch Review compositions, the final Solid logo, typography, tokens and theme scope are approved and recorded. Use those authorities during later Impeccable implementation; do not repeat visual selection or present historical mockups as implemented UI. Remaining work is interaction/state specification and rendered verification after build authorization.

- **Landing pages:** establish a distinctive visual identity, clear hierarchy, compelling product narrative and an obvious next action. Explain the difference between readiness audits and observed AI visibility. Use real product evidence when available; label illustrative examples. Never invent customer logos, testimonials, rankings, traffic lifts or live-looking metrics. In private phase 1, access and CTAs reflect invitation-only testing; public signup, preview and pricing activation follow the release boundary and approved commercial terms.
- **Application:** prioritize task completion and readable evidence across onboarding, site selection, audit results, content editing, visibility, agency/client views, billing and the lean admin. Keep navigation, filters, selection and draft state stable. Reveal detailed evidence progressively without hiding coverage, freshness, uncertainty or costs. Reuse shared typography, controls and spacing while giving dense workflows appropriate layouts.
- **Fluid behavior:** adapt layouts continuously across phone, tablet and desktop rather than shrinking desktop screens. Preserve scroll and focus through panels and navigation; use restrained transitions to explain state changes. Prefer transform/opacity motion, respect reduced-motion settings and never delay an action for animation. No scroll hijacking, essential hover-only actions or motion-dependent information.
- **Premium craft:** consistent spacing and alignment, purposeful typography, balanced content density, precise interaction feedback and clear copy. Review long names, large counts, empty charts, partial results, expired evidence and permission changes. Design loading, error and recovery states with the same care as successful screens.
- **Accessible performance:** retain the performance targets in section 4; check keyboard access, focus restoration, labelled controls, chart/table alternatives, contrast, zoom/reflow and touch reachability. Keep heavy editors, charts and visual effects off unrelated routes. Rich marketing treatments must remain usable and fast on mobile.

Later UI verification follows Impeccable's bounded process: inspect desktop/mobile together, batch the corrections and confirm with at most one further round for that polish cycle. Run its mechanical detector on changed UI targets once the UI is complete, alongside functional/accessibility checks; visual inspection alone does not prove those checks. Record actual browser evidence and remaining defects. No detector, screenshot or performance result is claimed for this documentation-only update.

### Approved workspace direction and implementation guidance

Approved direction: a calm analytical workspace with strong typography, restrained color, clear evidence and excellent information hierarchy. Use a neutral base, one brand accent and semantic status colors that remain legible without color. Option A — Solid is approved and finalized with AEO/GEO lettering embedded inside every L symbol at every size; the approved specification now fixes the cobalt baseline and Manrope/Inter pairing. Prefer purposeful layout and polished interactions over decorative effects or an interchangeable card grid.

Use the approved tokens for type scale, spacing, surfaces, borders, shadows, radii, focus and motion. Use the same primitives for forms, tables, badges, dialogs and feedback. Shadcn components are the starting point; review their final composition and accessibility. Light and dark app themes are approved with equal chart, focus, contrast and state quality. System is the default with a persisted user override; marketing keeps its fixed cobalt/white identity.

| Surface | Proposed experience |
| ------- | ------------------- |
| Marketing/preview | Clear product promise, one URL action, scope and privacy near submission, substantive result before signup |
| Onboarding | Short progressive steps; preserve submitted URL; connect optional services later; show verification status and recovery instructions |
| Overview | Show next useful action, readiness, observed visibility and search performance in separate sections with dates and coverage |
| Audit progress | Named stages, real page counts, last update, retry/failure details and acknowledged cancellation; no invented percentage or countdown |
| Results/issues | Compact summary plus actionable table; selecting an issue opens evidence and guidance while preserving filters/back position |
| Comparison | Resolved/persistent/new/unknown with scope/rule changes beside the delta; unchanged evidence never presented as improvement |
| Content | Evidence beside editable proposals, source links and revision history; explicit generation/export/draft actions and allowance display |
| Search performance | Date/filter context, accessible trends and tables, freshness and partial data; no spurious attribution of growth |
| Visibility | API/consumer surface selector, cohort, market, language, counts and failures; evidence drill-down from each metric |
| Agency portfolio | Site selector, bounded batch actions, client grants and branded report preview; scoped clients see no unrelated navigation or billing |
| Billing | Current plan, each allowance, renewal date, current provider/currency and clear change/cancel flow; no surprise switch between providers |

On phones, contextual navigation collapses cleanly, primary actions remain reachable and evidence panels become full-screen views. Tables offer a deliberate horizontal-scroll or compact-row pattern without hiding important status. Inspect at least 360px mobile width, tablet and wide desktop. Support 200% zoom, keyboard-only flows, reduced motion, visible focus, labelled controls and announced asynchronous state changes. Minimum WCAG 2.2 target size is respected; primary touch controls should be comfortably larger.

State coverage is a design deliverable: initial loading, empty, queued, progress, partial, stale, insufficient allowance, provider capacity exhausted, expired input, permission lost, disconnected integration, cancellation and retry. Every state explains what happened, whether any allowance was consumed and the next available action. Preserve user edits on recoverable errors. Do not expose internal provider error dumps in product copy.

## 4. Performance and resource efficiency

Use server-rendered product entry views and keep client components focused on interaction. Server components call authorized application/data functions directly rather than making an HTTP round trip to the same app. Paginate issue/history tables and request only required fields. Lazy-load chart libraries, rich editors and evidence viewers on the routes that need them. Reserve layout space for asynchronous content and optimize fonts/images.

Proposed field targets follow good Core Web Vitals thresholds: p75 LCP at most 2.5 seconds, INP at most 200 milliseconds and CLS at most 0.1, evaluated separately for mobile and desktop when enough traffic exists. Before field evidence, use documented lab scenarios and report their limitations. Do not claim lab results prove field performance. Establish route-specific JavaScript/network budgets from the first representative screens, then enforce regressions in CI; no arbitrary total Lighthouse score substitutes for interaction testing.

Proposed web API objective: p95 below 500ms for common reads excluding third-party work, measured with declared payloads, data sizes and deployment region. Admission returns a durable operation ID promptly; acquisition and generation run asynchronously. Existing PRD preview/audit completion goals apply only after sufficient capacity, not as a free-plan guarantee. Align Vercel compute and Supabase regions where possible; validate worker-to-database latency before selecting pooling extras.

Compute deterministic results once from stored snapshots, then serve immutable summaries. Cache only with tenant/site authorization in the access path. Derived report keys include snapshot/result hash, rule/result schema, template, locale and branding version. Source reuse for a fresh audit is explicit and labelled; a stale snapshot cannot prove a fix. Research keys include the objective and freshness requirements. Each scheduled visibility observation is a new sample; do not reuse a cached answer as a fresh measurement.

Keep large artifacts outside PostgreSQL. Index frequent ownership/status/time queries, avoid N+1 reads, use stable cursor pagination and examine representative query plans. Small transactions protect admission/settlement, never hold database transactions open during browser/model work. Process page-sized jobs with persisted checkpoints instead of retaining every raw DOM in one worker. Bound HTML/DOM size before parsing and keep pure parsing/evaluation within measured worker CPU/memory limits. Free Worker limits may require upgrading before the browser-time allowance is exhausted.

Separate queue capacity for interactive previews, audits and slow research/observation work where needed, while sharing the worker code/deployment when practical. Apply fair workspace admission, per-origin limits, provider concurrency caps, jittered retries and circuit breakers. Do not launch all sites/prompts at the same schedule boundary or retry permanent denials. Release user reservations correctly when a task cannot produce usable output; retain actual internal spend receipts.

## 5. Developer experience and maintainability

Keep one TypeScript workspace, one package manager, one product-database migration history and clear package boundaries. During phase 1 Supabase manages its auth schema separately, while Prisma owns product objects. Phase 2 adds reviewed Better Auth tables to the Prisma-owned schema; never migrate Supabase-managed auth objects as product tables. The rules engine is pure and testable without vendors. Database, provider and transport contracts stay small and concrete; avoid generic repository factories, dependency-injection frameworks and microservices without a need. Keep auth/session resolution separate from product authorization, and reuse one checked authorization context across a request.

The eventual development setup should provide documented install/dev/check/test/build commands, a safe environment template, local PostgreSQL fixtures, local worker/provider fakes, and a complete synthetic user journey without production credentials. Store fixture provenance and use redacted data. Validate environment configuration on startup, with actionable errors and no secret output. Pin the Node version, pnpm version, package versions and Wrangler compatibility date. Avoid introducing development hooks before their cost and team workflow are clear.

Use generated Prisma types and Zod at untrusted boundaries. One source of truth defines job/result/event versions and idempotency semantics. Distinguish errors such as invalid input, denied permission, insufficient allowance, provider throttling, partial evidence and platform failure. Attach safe correlation IDs through web admission, outbox, provider task and settlement without leaking customer text into telemetry.

CI should cover lint/type checks, meaningful unit and PostgreSQL integration tests, builds and a focused browser journey. Provider contract fixtures are versioned and refreshed deliberately. Controlled live-provider checks are separate and budgeted; do not make every pull request depend on paid API calls. Final authoritative validation uses raw output. Database migration compatibility, staging deployment and production acceptance remain separate checks.

## 6. Quality gates before the full release

1. Design review covers the preview, onboarding, results, content, visibility, billing and all important error/empty states on mobile and desktop.
2. Accessibility review covers contrast, keyboard/focus, semantics, zoom, target size and live status announcements.
3. Rules pass labelled fixtures, including non-indexability, unknown applicability, incomplete categories, normalized URL identity and comparison compatibility.
4. Authentication and tenancy tests cover member revocation, site grants, API tokens, artifacts, clients and last-owner protection.
5. Job tests cover duplicate admission/delivery, crash recovery, accepted provider task recovery, cancellation, quota exhaustion and settlement exactly once.
6. Research/editorial evaluations cover provenance, freshness, cached fallback, unsupported claims and injected source instructions.
7. API and consumer observation tests verify each promised surface, source/citation semantics, locale support, sample denominator and historical cohort behavior.
8. Billing tests exercise both providers, webhook signature/replay/order, renewals, disputes/refunds and cross-provider duplicate prevention.
9. Operational tests demonstrate budget enforcement, deletion, encrypted backup restore, provider outage handling and independent service operation.
10. Release evidence identifies source revision, raw local/CI results, deployed revision and authenticated browser/provider proof separately.

## 7. Remaining decisions and recommendations

Approved regions, private phase-one/Better-Auth-before-launch boundary, lean admin, selective feature split, vendors/models and seven optimizations do not need repeating. Section 8.3 lists later founder/setup decisions; section 8.4 links the finalized engineering contracts. Observation allowances, domain layout and pilot recovery are settled. Do not turn engineering settings into additional approval rounds.

The founder approved [the category schedule and deletion policy](./data-retention-and-deletion.md): longer compact history, shorter full-source archives, explicit protection for saved work and no misleading provider-wide deletion guarantee. Cost controls use compressed R2 Standard artifacts, bounded metadata, short export caches and rolling backups. Required records, processor logs and restore/deletion semantics must be verified; buying a monitoring or archive product is not automatically authorized.

The $10 per user testing budget and 25 Azure OpenAI API observations per user/month remain approved. Phase 1 stays private with Supabase Auth and the approved lean staff admin. Agency workflows, external integrations including GSC, advanced content/Parallel research and measurement dashboards remain included. Customer automation and advanced administration move to phase 2; the earlier Better Auth and PostHog assignments remain. Internal queues, billing callbacks, operational records, spend controls and in-app status stay in phase 1. The newer domain/email decision defers Brevo delivery to phase 2, after acquiring `lyraseoai.com`; dedicated Gmail SMTP is approved for phase-one email. Verify the full retained module surface and re-estimate its broad scope; no unapproved increase in live-provider budget follows from feature retention.

## 8. Consolidated planning review

Reviewed again on 2026-10-23 across all twelve current product/planning Markdown documents, the brand README/approval record and two historical design notes, against the founder's recorded decisions. This repository contains planning documents, not an implemented application. Public provider documentation was checked for material constraints; no provider account, deployment, tariff entitlement or production behavior was verified. No building, provisioning or purchases were performed.

**Conclusion:** the vendor choices, product direction and phase boundary are settled. The written engineering contracts and implementation sequence are complete. Provider verification, production spending and deferred business choices remain at their named gates; implementation has not begun. Do not reopen the selected stack or remove retained features to make the plan appear cheaper.

### 8.1 Contradictions corrected

| Finding | Resolution |
| ------- | ---------- |
| A legacy paragraph said Better Auth was no longer selected and another implied Supabase Auth in production | Supabase Auth is private phase 1 only; Better Auth is required before customer launch; Supabase Pro remains the production database choice |
| Parallel Task research remained described as opt-in | Search/Extract only; Task/Responses generation is not selected |
| DataForSEO asynchronous delivery was described as scheduling | Manual asynchronous Standard jobs are phase 1; recurring customer schedules are phase 2 |
| Some pilot allowances and the research cache had inconsistent approval labels | The $10/user budget, $8/$1/$1 split and 25 API / 200 consumer observations per user/month are approved; other pilot maxima remain proposed; the approved research reuse cache is 24 hours |
| Prisma ownership and auth references omitted the phase-two transition | Prisma owns product tables and the eventual Better Auth schema; Supabase-managed auth tables are not application migrations |
| Existing workers/endpoints and daily spend controls were implied | Execution and endpoints are planned; no smaller daily AI budget is approved; daily browser/abuse limits are separate |

Final consistency pass corrected stale pending-design/surface language, phase-one Gmail timing, implied editorial/research credit quotas and the extra 90% spending stop. Full-job reservations now determine affordability within the approved limits. Public commercial credit packaging is explicitly undecided. Proposed one-site/ten-audit pilot quantities are not approved entitlements. Historical design notes remain exploration records with pointers to current approvals.

The PRD and full-version specification are now version 2.8. The release-phase mapping retains all sixteen FULL modules. Earlier approval of all seven optimizations remains in force.

### 8.2 Material constraints and unresolved feasibility

| Area | Review finding and required treatment |
| ---- | ------------------------------------- |
| Hosting budget | The $10 per user envelope covers Azure OpenAI, Parallel and DataForSEO consumption only. Vercel Hobby is restricted to personal/non-commercial use; private business testing does not establish eligibility. Free-first testing now has $0 paid infrastructure approved; develop locally first and resolve eligible hosting before shared deployment, with no automatic purchase. |
| Free Cloudflare capacity | Browser minutes are only one limit. Workers Free HTTP/Cron CPU is 10 ms and memory is 128 MB; verify the effective queue-handler allowance separately. Free Queues retain messages for 24 hours. Use bounded page steps, durable database job state and reconciliation for expired/lost messages. An hour-long DataForSEO task lifecycle must span separate short submissions/polls rather than hold a consumer invocation open. |
| Azure availability and costs | The two model labels are approved choices, not evidence of deployable model IDs in this account. Verify the deployment/model mapping, region, capacity, tool support and tariff. Keep one SDK client and two deployments; if unavailable, return the concrete mismatch for a decision. Azure Bing request counts, not just visible search actions, inform observation cost receipts. |
| Budget versus allowances | Proposed resource maxima cannot all be guaranteed within $10 per user at their conservative job guards. Show both remaining allowance and budget; pause admission without silently degrading quality. DataForSEO's advertised $50 minimum top-up is a separate cash decision, not a $50 monthly usage requirement or an approved purchase. |
| Authentication | Better Auth's default two-factor flow does not automatically gate Google/email-OTP login; its passwordless enrollment option alone does not solve this. Specify server enforcement, identity mapping, revocation and recovery for both phases. Supabase Free does not validate Pro-only native timeout settings. |
| Integration access | GSC OAuth in external Testing mode can lose refresh access after seven days. Specify reconnect states. Private deployment protection must allow narrowly verified OAuth callbacks and signed webhooks without exposing product routes. |
| Privacy and recovery | Approved retention durations are product policy, not evidence of configured provider erasure or statutory compliance. Verify processor settings, required India log coverage, encrypted backups and deletion replay. The private-pilot 24-hour restoration/24-hour data-loss objective is approved; test restoration and reconciliation. Production objectives remain deferred. |

Sources: [Vercel fair use](https://vercel.com/docs/limits/fair-use-guidelines), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Queues limits](https://developers.cloudflare.com/queues/platform/limits/), [Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/), [Azure web search](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/web-search), [DataForSEO pricing/deposits](https://dataforseo.com/ai-optimization-api), [Better Auth two-factor behavior](https://better-auth.com/docs/plugins/2fa), [Better Auth Supabase migration](https://better-auth.com/docs/guides/supabase-migration-guide), [Supabase sessions](https://supabase.com/docs/guides/auth/sessions), [Google OAuth expiration](https://developers.google.com/identity/protocols/oauth2#expiration) and [CERT-In directions](https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf). Account-specific checks and applicable legal coverage remain open.

### 8.3 What remains to finalize later

The founder asked to defer remaining choices. No new question, purchase or building follows this review. Stack, features, design, pilot budgets, observation allowances, operator, recovery target and account preservation are settled.

| Remaining item | When required | Simple boundary |
| -------------- | ------------- | --------------- |
| Private-pilot cohort | Before invitations/funded testing | Confirm intended admitted users; $10 per user means up to $100/month for ten users. No automatic enrollment or added feature quotas. |
| Eligible hosted testing and upfront cash | Before shared deployment or any purchase | Local-first/$0 paid infrastructure stays approved. Decide only concrete required hosting upgrades or provider deposits; no automatic purchase. |
| Solo / Team / Agency commercial terms | Before phase-two public pricing/live checkout | Prices, site/member/usage allowances, billing cadence, INR/USD routing, trial/refund/grace/annual discount/top-ups; keep the same core quality. |
| Domain and production email identity | Acquire/control the domain before phase-two implementation; sender before delivery | `lyraseoai.com`, `app.lyraseoai.com` and app-host `/admin` are settled. Actual purchase/ownership, DNS and Brevo sender address remain setup work. Gmail address/credentials are phase-one setup inputs. |
| Production budget and recovery | Before production activation | Overall infrastructure ceiling, approved paid plans, restoration/data-loss objectives and finance reconciliation; pilot recovery remains 24 hours / 24 hours with seven daily restore points. |
| Phase-two telemetry and public policies | Before activation/customer launch | PostHog consent/retention/volume controls, final privacy/terms and entity-specific financial retention based on verified processor/legal requirements. |

Engineering owns model efforts, token/time/retry bounds, compatible libraries, exact provider settings and schema/API details within the approved scope. These are not further founder micro-decisions. Escalate only a concrete conflict with cost, scope, privacy or quality. The approved 25 API / 200 consumer observations and $8/$1/$1 split do not require another vote.

### 8.4 Engineering specification finalized

On 2026-10-23 the founder authorized finalizing engineering contracts and preparing the plan, while leaving business decisions deferred and building unauthorized.

- [Engineering contracts](./engineering-contracts.md): small runtime layout, stable identity/tenancy schema, auth/MFA/step-up/migration, APIs/states, budget reservations, leases/outbox/reconciliation, provider bounds, integrations/exports, deletion/recovery and UI states. PostgreSQL counters replace the proposed extra Durable Object component initially.
- [Audit and measurement contracts](./audit-and-measurement-contracts.md): exact initial rule predicates and fixtures, versioned scoring/coverage, comparisons, brand ambiguity, observation denominators, share of voice, weighting and minimum comparable trend evidence.
- [Implementation plan](./superpowers/plans/2026-10-23-lyraseo-implementation.md): sixteen dependency-ordered tasks, proposed files/interfaces, regression cases, commands, FULL-module mapping and an 81–135 engineering-day full-scope estimate. This is an estimate, not a delivery commitment.

Provider/runtime capability, actual pricing, account acceptance and recovery evidence remain execution gates. They are not missing written product choices and cannot be declared passed from documentation. No new vendors, monthly content quotas, public commercial terms or spending were introduced.

### 8.5 Exit from planning

The written engineering baseline and implementation sequence are complete. Remaining business choices in section 8.3 stay deferred until their named gates. Building still requires explicit founder authorization. Start locally with synthetic fixtures after that authorization; verify live capabilities within approved funding before private users, then obtain domain control before phase-two implementation. Return any material scope/cost/security conflict with evidence instead of silently weakening the contract.

## 9. Primary references

- [Parallel API chooser](https://docs.parallel.ai/getting-started/choose-an-api), [Search practices](https://docs.parallel.ai/search/best-practices) and [Extract settings](https://docs.parallel.ai/extract/advanced-extract-settings): research scope and freshness configuration.
- [DataForSEO LLM Scraper overview](https://docs.dataforseo.com/v3/ai_optimization-llm_scraper-overview/): documented ChatGPT/Gemini coverage and Standard versus Live delivery.
- [DataForSEO ChatGPT scraper fields](https://docs.dataforseo.com/v3/ai_optimization-chat_gpt-llm_scraper-live-advanced/) and [Perplexity Responses](https://docs.dataforseo.com/v3/ai_optimization/perplexity/llm_responses/overview/): distinguish surface and evidence contracts.
- [Web Vitals](https://web.dev/articles/vitals): performance metric targets and field-measurement interpretation.
- [Cloudflare Browser Run limits](https://developers.cloudflare.com/browser-run/limits/): initial free capacity and admission constraints.

### Final-review source refresh — 2026-10-23

Public pages reconfirmed Vercel Hobby's non-commercial restriction, Browser Run's ten free browser minutes/day, and DataForSEO Standard pricing at $0.0012/result ($0.24 for 200 before retries/taxes). Its advertised turnaround is qualified as an average, not a guaranteed SLA. Microsoft catalog search results list both approved model names; actual Azure subscription deployment access and tariffs remain unverified. Existing account-specific and processor/legal gates remain open; this was not a fresh legal or provider-account audit.

Sources: [Vercel fair use](https://vercel.com/docs/limits/fair-use-guidelines), [Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/), [DataForSEO pricing](https://dataforseo.com/pricing/ai-optimization/llm-scraper), [Microsoft model catalog](https://learn.microsoft.com/en-us/azure/ai-services/openai/overview).
