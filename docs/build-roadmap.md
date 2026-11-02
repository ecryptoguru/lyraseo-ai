# Lyraseo implementation roadmap

Approved on 2026-11-02. Build the recommended enhancements for the private pilot, then expand hosted Lyraseo to the customer-facing workflows in OpenSEO v0.1.21 at `beca5c1f5c728acfb243249107dbfaded0ef552e`. Preserve the existing Next.js, Prisma/PostgreSQL and worker architecture, private access, deterministic measurement contracts, and budget policy.

## Current delivery

The initial repository includes the existing synthetic audit UI and private-access foundation plus new server-issued operation quotes, stored executable request input, atomic admission, queue publication/recovery services and authenticated operation polling. These services have local PostgreSQL regressions. The Cloudflare worker still returns unavailable pending guarded acquisition, provider adapters and runtime qualification. The first real audit journey remains open.

| Private-pilot milestone | Implementation state | Acceptance still required |
| --- | --- | --- |
| 1. Baseline and private access | Prior 16 tasks inventoried locally; public repository and CI established | Live sign-in, recovery, MFA and private-pilot acceptance |
| 2. Durable execution and cost | Quote/admission/publisher/recovery/polling services implemented | Trusted provider tariffs, running queue consumers, receipts/reconciliation adapters and operator controls |
| 3. Real audits and fixture website | Initial deterministic engine and synthetic UI exist | Domain proof, guarded acquisition, frozen manifest, persistent evidence/results, crawler harness, rerun and comparison |
| 4. Business context and page workspace | Planned | Versioned context, stable page identity, findings, assignments, drafts and history |
| 5. GSC and opportunity inbox | Planned | Read-only OAuth/imports, comparable windows, actionable page/query evidence |
| 6. Editorial and private reports | Sample draft/CSV exist | Grounded editable briefs, internal links, private PDF/CSV and WordPress draft handoff |
| 7. AI observations and competitors | Initial metric helpers exist | Versioned panels, actual surface provenance, retained answers/citations, compatible trends |
| 8. GA4, keyword enrichment and MCP | Planned | Optional measured-outcome joins, quoted enrichment, read-only authorized agent tools |
| 9. Integrated private-pilot gate | Planned | Teams/client access, webhooks/tokens, sandbox billing, privacy/deletion, backups and recovery |

## Phase-two roadmap

Confirm domain control before phase-two implementation and obtain approval for paid commitments before purchase or activation.

| Wave | Deliverables |
| --- | --- |
| 2A. Production foundation | Better Auth/Brevo cutover preserving product identities, MFA, membership and budgets; production telemetry/commerce, capacity and recovery |
| 2B. Research | Keyword discovery/lists/clustering, SERP inspection, domain/page footprints and competitor gaps with actual source/market/timestamps |
| 2C. Rank and backlinks | Market/device/depth/cadence tracking, retained SERPs, backlink/referring-domain analysis, competitor comparison and link prospecting |
| 2D. Local SEO | Explicit business/listing selection, local keywords, Maps/Local Finder and geographic grids with accessible tables and whole-grid quotes |
| 2E. Advanced AI and agents | Qualified additional surfaces, prompt/cited-source research, guided assistant, agent workflows, quoted MCP execution and verified IndexNow submission |
| 2F. Automation and agencies | Schedules/alerts, portfolios, advanced administration, branded interactive reports, revocable sharing and bounded public utilities |

Self-host distributions are a separate product decision. Public pricing, commercial policy, funding and provider-account approval remain release dependencies.

## Verification gates

Every milestone requires raw lint/typechecks, formatting, unit tests and a production build. Database changes additionally require integration tests against restricted roles on disposable local PostgreSQL and migration replay from empty and populated baselines. User-facing changes require desktop/mobile Playwright, keyboard/focus, loading/error/empty/partial states and actual rendered inspection. Provider acceptance uses a separately budgeted controlled corpus with retained provenance, never synthetic measurements presented as live observations.

The `Verify` GitHub workflow installs the frozen lockfile, prepares disposable PostgreSQL, generates Next.js types, runs checks and tests, builds, then runs Chromium browser tests. It receives no cloud-provider credentials. Local operational evidence stays under ignored `docs/evidence/` and `output/` paths.

The first complete product checkpoint is a private user verifying a controlled site, auditing a frozen manifest, fixing a known defect, rerunning it, and exporting a report showing the resolved issue alongside a deliberately unreadable page. Continue with worker/acquisition and audit persistence toward that checkpoint.
