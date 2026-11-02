# LyraSEO AI

Independent search-readiness and AI-visibility product. Phase one is under active local development. The application currently demonstrates synthetic audit evidence, interactive finding review, local reruns, CSV export, draft editing and responsive light/dark UI. This tranche also adds a guarded Supabase sign-in adapter, authenticated workspace, tenant services and transactional job/budget accounting. Live authentication requires dedicated project configuration and acceptance; acquisition, provider dispatch, queues, billing and production acceptance are not enabled.

## Run locally

Use Node24 and pnpm11.13.1:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open [the landing page](http://127.0.0.1:3000) or [the sample audit](http://127.0.0.1:3000/app/audits). Provider credentials are unnecessary. Development binds only to loopback. Hosted fixture/customer/API access fails closed; never use this sample as a deployed authentication system.

## Verify

```sh
pnpm check
pnpm test:unit
pnpm db:local
pnpm test:integration
pnpm test:e2e
pnpm build
```

`db:local` requires a running Docker daemon. It creates/reuses only `lyraseo-phase1-postgres`, a local PostgreSQL17 test container at port54329, applies the Prisma migration and provisions a restricted test role. Credentials in the script/tests are disposable local-only values. Integration tests reset only the fixed local `lyraseo_test` database; do not change them to point at customer/cloud data. Stop local resources with `docker stop lyraseo-phase1-postgres`; no automatic database deletion occurs.

A new machine may need `pnpm --filter @lyraseo/web exec playwright install chromium` for browser tests. Tests cover desktop/mobile interactions and bounded automated accessibility checks; these are not a full accessibility-conformance claim. Generated Prisma client files are reproduced by `db:local` and excluded from source tracking. For a plain type check after a fresh checkout without Docker, run `pnpm --filter @lyraseo/db exec prisma generate` first.

The approved plan and policies are indexed in [docs](docs/README.md). Actual evidence and unfinished work are recorded in [phase-one progress](docs/evidence/phase-one-progress.md). Free-first remains in force; paid upgrades need approval. Phase two and business decisions stay deferred.

See the [private-pilot auth and ledger runbook](docs/runbooks/private-pilot-auth.md) for required configuration, restricted roles and unverified live gates. Do not enable authentication just by adding provider credentials; complete the explicit prerequisites and verify the actual project first.
