# Lyraseo implementation roadmap

Approved on 2026-11-02. Build the recommended enhancements for the private pilot, then expand hosted Lyraseo to the customer-facing workflows in OpenSEO v0.1.21 at `beca5c1f5c728acfb243249107dbfaded0ef552e`. Preserve the existing Next.js, Prisma/PostgreSQL and worker architecture, private access, deterministic measurement contracts, and budget policy.

## Current delivery

The private-pilot branch now includes durable operation services, session-bound site proof, frozen raw audit manifests and evidence, reviewed business context, stable page workspaces, Search Console imports/opportunities, manual evidence-backed draft revisions, private PDF/CSV reports, versioned AI panels, and scoped read-only MCP credentials. These are local implementations with fixture/database/browser evidence. They are not a hosted pilot release. The Cloudflare worker still returns unavailable; provider collection, rendered acquisition and live acceptance remain open.

New audits use the versioned `readiness-v2` contract with reviewed expectations, source-specific completeness, rule evidence references and category coverage. Historical v1 results remain reproducible and unchanged. Comparisons preserve uncertainty and invalidate affected findings when the declared basis changes. The raw profile still cannot supply rendered evidence or a complete readiness score.

| Private-pilot milestone | Implementation state | Acceptance still required |
| --- | --- | --- |
| 1. Baseline and private access | Prior16 tasks inventoried; public repository and CI established; tenant/site authorization tests | Google sign-in setup, SMTP/OTP, MFA/recovery and protected hosted acceptance |
| 2. Durable execution and cost | Server quotes, atomic admission, publication/recovery and polling services | Qualified tariffs, actual queue consumers, provider receipt/reconciliation adapters and operator controls |
| 3. Real audits and fixture website | Locally gated raw acquisition, session-bound site proof, immutable manifests, leased page checkpoints, fixture-site HTTP fix/rerun/comparison and CSV; rendered-head rules remain UNKNOWN | Hosted authenticated journey; actual worker runtime, rendering and subresource isolation/capacity qualification |
| 4. Business context and page workspace | Immutable reviewed context; exact URL identities, change journal, self-assignment, linked draft revisions and saved evidence | Broader team assignments, verified alias mapping when needed, hosted reopen/revocation acceptance |
| 5. GSC and opportunity inbox | Independent read-only OAuth, property selection, bounded cached imports, comparable-window opportunities and scoped UI | Live property reconciliation, refresh/backfill orchestration, explicit corrected-import versioning |
| 6. Editorial and private reports | Manual editable briefs/drafts, captured source/context revisions, observed anchor context, immutable private PDF/CSV | Qualified paid generation/research, report templates/branding, WordPress draft handoff and live client journey |
| 7. AI observations and competitors | Reviewed versioned panels, trusted evidence recorder, actual-profile provenance, deterministic multi-brand metrics and cohort thresholds, evidence UI | Qualified ledger-backed live collectors, persisted semantic adjudication and actual provider receipts |
| 8. GA4, keyword enrichment and MCP | Revocable scoped read-only credentials and six genuine MCP tools; optional independently connected GA4 with compatible exact landing-page outcomes | Live GA4 outcome reconciliation, quoted keyword enrichment, full hosted authenticated MCP acceptance |
| 9. Integrated private-pilot gate | Shared authorization/budget foundations and local recovery regressions | Team/client management, signed webhooks, sandbox billing, lean admin, physical retention/deletion, encrypted backups/restore and integrated live journeys |

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

The first complete product checkpoint remains a private user verifying a controlled site, auditing a frozen manifest, fixing a known defect, rerunning it, and exporting a report showing the resolved issue alongside a deliberately unreadable page. The controlled local fixture demonstrates acquisition, a corrected defect and an unreadable page; the protected authenticated hosted walkthrough remains open.
