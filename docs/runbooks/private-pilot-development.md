# Private-pilot development and verification

This is a local implementation checkpoint. Passing fixture, database or browser tests does not establish hosted authentication, provider qualification or release acceptance. The approved scope and remaining work are tracked in [the roadmap](../build-roadmap.md).

## Local checks

Use Node 24, the pinned pnpm version and a running Docker engine:

```sh
pnpm install --frozen-lockfile
pnpm db:local
pnpm check
pnpm format:check
pnpm test:unit
pnpm test:integration
pnpm test:migrations
pnpm build
pnpm test:e2e
```

`db:local` only prepares the named local PostgreSQL 17 container on 127.0.0.1:54329. Integration tests reset their disposable test database. They must not be pointed at a hosted or customer database. `test:migrations` creates separate temporary local databases, exercises empty, populated seven-migration and populated twenty-migration upgrades, verifies exact audit, outbox, receipt and ledger history, then drops only the databases it created.

The crawler fixture is exercised by `tests/integration/audit-journey.test.ts` using the production acquisition/evaluation services, controlled HTTP responses and real restricted-role PostgreSQL. Its mapped test transport is not a production DNS or Cloudflare isolation proof. Browser fixtures mount the actual components with controlled API responses; actual-handler PostgreSQL tests separately cover route/service wiring. A protected, authenticated, hosted walkthrough is still required.

## Local dispatch cutover

1. Stop local admissions and every legacy publisher before migration 016. Await in-flight sends and discard any prefetched operation references. A database lock cannot recall a message held by another process.
2. For an upgrade with archived events, run `LYRA_LOCAL_OUTBOX_DRAINED=true pnpm db:local` only after that drain. The bootstrap also requires that no other client remain connected during the cutover check. Fresh bootstrap uses `pnpm db:local`.
3. Verify all eight policy rows are disabled and the restricted web login cannot read or update the outbox. Compare the original operation, receipt, budget and archived-event records. Start the updated admission code only after those checks pass. Rollback keeps admissions quiesced and dispatch closed.
4. In disposable fixtures only, `lyraseo_operator` can read a named policy and change its expected revision. `lyraseo_dispatch` can exercise opaque controlled audit references. The disposable bootstrap registers the database OID and the current PostgreSQL postmaster start time. Restarting PostgreSQL or restoring a physical copy closes controlled delivery. Rerun the validated local `pnpm db:local` bootstrap only on the intended disposable instance to requalify it. Neither connection belongs in normal web initialization. Existing local audits keep their browser driver. Paid reservations stay quarantined or available for financial reconciliation. There is no queue or external publisher in this tranche.

## Private authentication and rollout

Follow [the authentication runbook](./private-pilot-auth.md). Configure provider secrets only through the local environment or deployment secret manager. Keep `LYRA_AUTH_ENABLED=false` until the read-only preflight and interactive OTP, Google, MFA, recovery and revocation acceptance pass. No fixture header or sample screen supplies a real identity.

Apply and verify additive database migrations with the appropriate restricted runtime grants before enabling a feature. `LYRA_ENABLED_CAPABILITIES` is a server-only comma-separated allowlist: `audits,context,search,analytics,content,visibility,mcp`. The default is empty. Enable capabilities individually for the approved private cohort, then remove a name to pause its mutations and collection. Existing authorized saved evidence remains readable; cancellation, integration disconnect and token revocation remain available. A feature flag cannot grant site access or qualify a provider.

Raw local acquisition additionally requires `LYRA_LOCAL_RAW_AUDITS=true`, configured private authentication and a loopback application origin. It is refused on Vercel. Enabling a rollout flag does not relax that boundary or enable the unfinished worker.

## Controlled audit walkthrough

1. Sign in, choose the correct workspace, and register a site you control. Owner/admin management is separate from an editor’s site grant.
2. Issue a new ownership challenge. Place the one-time file at the exact displayed well-known URL and verify it from the same signed-in session before expiry. A newer challenge replaces the previous pending challenge.
3. Review business context. Future audits identify the context revision they used; updating context does not rewrite earlier evidence.
4. Confirm a small same-origin manifest, including the homepage, with at most 25 pages. Review the optional declarations for identity, official/contact/policy URLs, page type, indexing intent and expected canonical. Declarations describe expectations; they do not supply observed page evidence. Start the audit explicitly. The local driver acquires one page per POST and checkpoints each completed page. Reopen and resume if the tab closes.
5. Inspect the saved HTTP receipt, raw-source availability, rule outcome and missing-evidence explanation. Scripts and subresources are not executed. Raw title/canonical/anchor diagnostics are labelled as raw observations; rendered-head/body checks remain UNKNOWN without rendered evidence. A raw-only audit does not earn a complete numeric score.
6. Correct a raw-observable defect on the controlled site, such as a page returning 404 that should return 200. Rerun the same manifest and compare the saved runs. Include a deliberately unreadable page to verify that it stays unevaluated rather than becoming an invented pass.
7. Register exact URLs in page workspaces. Regional paths, trailing slashes and meaningful parameters stay distinct. Record changes or claim a task without changing measured outcomes. Link a saved draft revision when recording a change.
8. Create a private evidence report from explicitly selected saved sources, using its independent title and source controls. To include the rerun comparison, select both completed audits, enable the frozen comparison, and explicitly choose the before and after runs. The PDF names resolved and unevaluated findings; the CSV retains the complete frozen comparison and selected evidence. Inspect both exports for source dates, scope, context, coverage and limitations. Report downloads reauthorize current site access. Later context changes and audits do not rewrite a saved report.

New audits freeze the `readiness-v2` methodology, acquisition profile, reviewed declarations and business-context revision at admission. Saved `readiness-v1` runs retain their original evaluator and numbers. Comparisons require compatible versions and sources; a changed expectation, missing page or unknown outcome cannot become a verified fix. Report snapshots retain the originally selected evidence.

## Optional Google connections

Search Console and Analytics use independent readonly consent, encrypted credentials, explicit property selection and separate disconnect controls. Register the exact callback URLs for the chosen application origin:

- `/api/integrations/google/callback`
- `/api/integrations/analytics/callback`

Property discovery and bounded imports require explicit actions. Reading saved imports, opportunities or reports does not contact either provider. Search Console keeps comparable windows and derives aggregate CTR from clicks/impressions. A secondary page ranking lower cannot promote a query whose best observed page already ranks highly.

Analytics additionally requires an explicitly selected matching web stream. It preserves per-date session metrics and property timezone, unmatched landing pages, threshold/sampling/partial diagnostics and actual report scope. Missing pages do not inherit homepage outcomes. Search Console’s Los Angeles calendar dates are not silently combined with another GA4 timezone. Session key-event rates are not averaged or converted into invented integer conversion counts.

Selection and credential refresh preserve immutable imports. Disconnect stops processing and purges that integration’s imported datasets. Independently saved authored work and report snapshots follow their own documented lifecycle.

## Drafts, observations and agent reads

Manual briefs/drafts require selected captured evidence, citation notes and explicit assumptions. Revisions use optimistic concurrency; preserve local edits before loading a newer revision after a conflict. Internal-link context comes from actual bounded raw anchors between acquired pages and does not claim rendered visibility.

AI panels keep immutable prompt/brand versions, review identity, neutral/branded labels and English/India scope. No observations exist merely because a panel is reviewed. Failed, unsupported, ambiguous, measured-absent and synthetic evidence stay distinguishable. Live collection remains unavailable until the provider contract and ledger-backed executor are qualified. Credentials alone do not complete that work.

Create read-only MCP credentials in the workspace’s API access page using fresh authentication. Select only necessary sites and scopes, copy the secret once to the client’s credential manager, then dismiss it. `/api/mcp` accepts Bearer credentials and offers six saved-evidence tools. A token never starts a provider job. Revocation, expiry, changed site access, suspension or changed security policy stop subsequent reads. Do not put secrets in URLs, public examples or logs.

## Evidence and release limits

The implemented access boundaries expire raw audit HTML after 30 days and raw AI answers after 90 days, with compact measurement history bounded to 13 months. Physical cleanup, processor erasure, encrypted backup scheduling and isolated restore/deletion replay still require implementation and acceptance; these read limits are not proof of physical erasure.

The Cloudflare consumer, rendered acquisition, qualified paid generation/research/observation/keyword execution, WordPress handoff, signed outbound webhooks, sandbox commerce, team/client administration and the integrated live-pilot gate remain separate work. Retain the approved per-user monthly $10 budget and its $8/$1/$1 provider partitions. No automatic top-up or paid account activation follows from a feature flag. Phase two cannot begin before domain control is confirmed.

## Signed audit bridge rehearsal

Migration 017 moves browser audit lifecycle writes behind scoped SQL functions and adds a separate execution path for the disposable controlled fixture. Quiesce audit writers while applying the migration and matching web binary. Existing local admissions use the web login, existing actor transaction and local profile. A browser can cancel a controlled run in its authorized scope. That transaction also suppresses the run's outstanding delivery.

Run `pnpm db:local` on the disposable local instance, then `pnpm exec vitest run tests/integration/signed-node-bridge.test.ts`. The suite creates a fixture audit as the local administrator, uses ephemeral signing keys and starts a separate listener bound to an automatically assigned port on 127.0.0.1. Only the test process injects the restricted database connection and in-memory fixture responses. The web app has no bridge listener or signing keys at startup. Requests to the reserved runtime prefix on the web origin return 404 before the proxy reads browser credentials.

The five POST commands are `/api/internal/runtime/dispatch`, `/api/internal/runtime/dispatch/ack`, `/api/internal/runtime/dispatch/defer`, `/api/internal/runtime/step` and `/api/internal/runtime/recover`. A body selects only a bounded batch or opaque delivery reference. Sign exact raw bytes using the protocol fields and golden vectors in `packages/contracts/src/runtime-signing.ts` and `tests/fixtures/runtime/signing-v1.json`. Keys must contain at least 32 independently random bytes, map to the single `lyraseo_dispatch` principal, specify the `lyraseo-kernel-a` audience and allow the requested action. Rotation can temporarily list two key IDs for that same authority. Removing a key denies new requests and aborts an active fixture attempt at the next authority check.

An early step before sender acknowledgement returns retry. After acknowledgement, replay reserves a separate 90-second ownership lease. The handler has 45 seconds total, including ingress, and the raw receipt has 15 seconds. The private proof expires at the earliest applicable deadline. Policy and sponsor checks poll every 200 ms with a 650 ms abort deadline and run again before each fixture dispatch. A step stores its checkpoint, yield or terminal evaluation, delivery transition and replay result in one database transaction. After losing a response, replay with the identical signed body, timestamps and request ID while the envelope is valid. After expiry, sign a fresh request and rely on persisted generation and target fences. A process crash may cause another free fixture acquisition after lease recovery.

Hosted ingress requires a separate HTTPS origin and proof that its front door preserves the literal request target and rejects aliases and duplicate headers. Queue delivery, hosted admission, provider calls and customer audit promotion have separate acceptance gates.

The receipt byte budgets measure the exact compact UTF-8 subdocuments the adapters submit. An HTML BOM stays in the stored original text and its SHA-256. The HTML parser ignores the BOM, and a BOM-only body has unavailable evidence. Signed carrier JSON must have no BOM. HMAC verification snapshots the candidate key bytes and authority before its first asynchronous operation and rechecks the current keyring before dispatch.

For a default-duration deadline rehearsal, run `LYRA_BRIDGE_DEFAULT_DEADLINE_PROBE=1 pnpm exec vitest run tests/integration/signed-node-bridge.test.ts -t 'round1 delayed body'`. This holds the last body chunk for about 44 seconds and contends on a policy row. The listener's remaining wall-time budget limits the response, connection wait, each database statement and the transaction. The fixed SQL admission independently checks its deadline again after acquiring locks.

The compact receipt limits are 256 KiB for evaluation evidence and 32 MiB for provenance. PostgreSQL also checks the byte length of its JSONB text representation. Independent ceilings of 512 KiB and 64 MiB allow separator formatting while preventing small exponent-form numbers from expanding into oversized documents. The final page revalidates each prior evidence document before aggregating it, including preexisting rows. At most 24 prior documents can enter a 25-page evaluation. The listener retains its startup budget and enrolled fixture, while the keyring callback remains live for rotation.
