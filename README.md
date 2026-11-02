# LyraSEO AI

Independent search-readiness and AI-visibility product, under active private-pilot development. The local implementation includes authenticated tenant/site services, frozen raw audit evidence, reviewed site context, page change journals, optional GSC/GA4 connections, manual evidence-backed draft revisions, private PDF/CSV reports, versioned AI panels and scoped read-only MCP. The sample workspace remains visibly synthetic. Provider execution, the Cloudflare consumer, rendered acquisition and protected hosted acceptance remain open; adding credentials alone does not complete those capabilities.

## Run locally

Use Node 24 and pnpm 11.13.1:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open [the landing page](http://127.0.0.1:3000) or [the sample audit](http://127.0.0.1:3000/app/audits). Provider credentials are unnecessary. Development binds only to loopback. Hosted fixture/customer/API access fails closed; never use this sample as a deployed authentication system.

## Verify

```sh
pnpm check
pnpm format:check
pnpm test:unit
pnpm db:local
pnpm test:integration
pnpm test:migrations
pnpm test:e2e
pnpm build
```

`db:local` requires a running Docker daemon. It creates/reuses only `lyraseo-phase1-postgres`, a local PostgreSQL 17 test container at port 54329, applies the Prisma migration and provisions a restricted test role. Credentials in the script/tests are disposable local-only values. Integration tests reset only the fixed local `lyraseo_test` database; do not change them to point at customer/cloud data. Stop local resources with `docker stop lyraseo-phase1-postgres`; no automatic database deletion occurs.

A new machine may need `pnpm --filter @lyraseo/web exec playwright install chromium` for browser tests. Tests cover desktop/mobile interactions and bounded automated accessibility checks; these are not a full accessibility-conformance claim. Generated Prisma client files are reproduced by `db:local` and excluded from source tracking. For a plain type check after a fresh checkout without Docker, run `pnpm --filter @lyraseo/db exec prisma generate` first.

The approved plan and policies are indexed in [docs](docs/README.md). The [build roadmap](docs/build-roadmap.md) records delivered capabilities and remaining milestones. Local operational receipts are retained in the ignored `docs/evidence/` directory. Free-first remains in force; paid upgrades need approval. Phase-two implementation follows its domain and release prerequisites.

See the [private-pilot auth and ledger runbook](docs/runbooks/private-pilot-auth.md) for required configuration, restricted roles and unverified live gates. Do not enable authentication just by adding provider credentials; complete the explicit prerequisites and verify the actual project first.

The [private-pilot development walkthrough](docs/runbooks/private-pilot-development.md) covers controlled audits, capability rollout, saved evidence, optional Google connections and MCP credentials. It distinguishes local fixture proof from the live acceptance still required.
