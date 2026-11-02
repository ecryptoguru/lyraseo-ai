# LyraSEO AI engineering contracts

Version: 1.0 · Finalized for planning: 2026-10-23.

The founder authorized finalizing engineering details and the implementation plan, not building. This document resolves the technical choices previously left open in DEC-03/04/09. It supplements the approved [full-version specification](./full-version-spec.md), [release phases](./release-phases.md), [usage policy](./usage-and-cost-policy.md) and [retention policy](./data-retention-and-deletion.md). Approved product/budget/privacy decisions win; this document owns engineering behavior where earlier text said proposed. Provider capability and cost checks are execution gates, not claims of verified implementation.

The exact rule catalogue and metric math are in [audit and measurement contracts](./audit-and-measurement-contracts.md). Public prices, credit packaging, site/member allowances, trial/refund/grace policies, production spending and telemetry/legal settings stay deferred. No one-site/ten-audit pilot entitlement is introduced.

## 1. Small architecture and runtime ownership

Use the existing planned paths: `apps/lyraseo-web`, `apps/lyraseo-worker`, `packages/contracts`, `packages/db`, `packages/visibility`. These paths do not exist yet. One Next.js project owns marketing, auth, application, staff UI and APIs. One Cloudflare worker deployment handles queue consumers, internal dispatch/polling and cleanup, with separate handlers rather than microservices. Start with one work queue and one dead-letter queue; PostgreSQL dispatch priority prevents long work starving interactive admission. Add queues only if measurements establish contention.

- Node web runtime: Supabase SSR, Prisma, authenticated APIs, Gmail SMTP, GSC OAuth, WordPress requests and PDF generation. Use a small private, authenticated Node job-step endpoint for PDF/SMTP when the worker cannot perform that step. The worker orchestrates it; the Node handler verifies operation state/lease and a short-lived signed internal request. It accepts an operation ID, never arbitrary HTML, recipient or URL from a queue.
- Worker runtime: bounded browser acquisition, pure rule evaluation, Azure/Parallel/DataForSEO HTTP requests, R2 artifact IO and durable job progression. Each checkpoint handles one page or one external operation. Pin a supported Prisma PostgreSQL adapter after verifying the actual Worker compatibility date/runtime.
- Prisma owns product migrations and eventual Better Auth tables. Supabase owns its managed auth schema. One dedicated PostgreSQL database, restricted runtime roles, migration credentials used only by deployment administration. No Redis, vector store, LLM gateway, generic plugin system or additional crawler.
- Use PostgreSQL atomic counters for private-pilot abuse/admission and one durable outbox. Do not add Durable Objects initially; use short indexed counter transactions. Revisit only if measured public-preview traffic requires it.
- Select Zod, Vitest, Playwright, a DOM parser compatible with Workers, and a maintained Node PDF renderer that consumes structured local report data. Prefer React-PDF for PDF output and native SVG for initial charts; plain textarea-based editing for Markdown drafts. No rich-text editor or chart dependency until a retained workflow needs it. Validate font/export compatibility in the first PDF task.
- Pin mutually compatible stable Node, pnpm, Next.js, Prisma, driver and SDK versions during the first authorized build. Do not copy unverified examples across major versions. Record exact versions and runtime capabilities in a compatibility receipt before connecting live services.

Alternatives rejected for the pilot: extra services/Redis increase operating cost; a generic provider/router layer adds unused maintenance; one synchronous request per audit cannot survive refresh, crashes or provider delays. The selected design uses one web app, one worker and the existing database for durable coordination.

## 2. Identity, tenancy and schema boundaries

All product IDs are opaque cuid strings. Provider subjects retain their native string format. All timestamps are UTC instants; provider date-only datasets retain their documented date semantics. All tenant-owned rows contain `workspaceId`; site-owned rows also contain `siteId`. Composite foreign keys prevent attaching a child to a site in another workspace. Product identity never uses email or a provider UUID as the primary key.

| Records | Keys and required invariants |
| ------- | ---------------------------- |
| ProductUser, ProviderIdentity | Stable user ID; unique `(provider, subject)` maps to user. Suspension/deletion state and security version belong to ProductUser. No auto-link by matching submitted email. |
| Workspace, Membership, SiteGrant | Unique `(workspaceId,userId)` membership and `(workspaceId,siteId,userId)` grant. Roles OWNER/ADMIN/EDITOR/VIEWER. Ownership transfer/removal locks workspace; at least one active owner survives. |
| StaffGrant, SupportCase | Staff grant separate from customer roles. Each permitted mutation has actor/reason/case/result; content access requires case-scoped permission. No first-user promotion. |
| Site, SiteVerification, Manifest | Canonical exact HTTPS origin; verification token hash and expiry; immutable confirmed manifest of at most 25 unique URLs. Verification is workspace-bound; no parent-domain expansion. |
| Operation, OperationStep, OutboxEvent | Immutable actor/budget-owner/scope/input hash; unique idempotency identity; checkpoint and lease fencing; outbox delivery is independently retryable. |
| BudgetPeriod, Reservation, UsageReceipt | Unique `(userId,UTC month,provider)` plus combined account row; exact USD decimal cost, committed and actual amounts; unique settlement per operation/provider. |
| AuditResult, RuleResult, IssueAction | Immutable versioned evidence/results; workflow actions separate from computed status. Unique `(auditId,ruleId,scopeKey)` instances. |
| Artifact, DeletionMarker | Private object key, category, hash, size, owner, created/expires/deleted times. Marker/restore journal survives restoring the product snapshot. |
| ResearchSnapshot, ContentRevision | Input/source/prompt/model versions and evidence references; explicit saved/pinned flag; optimistic revision number. |
| PromptPanelVersion, Observation, BrandIdentity | Immutable prompt/configuration; unique logical observation key; raw answer artifact separate from compact metrics. Alias review status never silently remaps history. |
| IntegrationConnection, ApiToken, WebhookDelivery | Encrypted provider secrets, hashed API tokens, scoped grants, revocation timestamps; immutable delivery IDs and attempts. |
| BillingAccount, Subscription, BillingEvent | Unique provider event ID; one active base subscription across providers; verified receipts, environment and provider-specific customer/price identifiers. |

Do not instantiate phase-two Schedule/AlertPreference or Better Auth/PostHog tables in phase 1. Required initial indexes: workspace/site plus created time and ID for lists; operation status/nextAttemptAt; outbox deliveredAt/nextAttemptAt; artifact expiry; unique keys above. Paginate at 50 default/100 maximum with `(createdAt,id)` cursors. No unrestricted cross-workspace admin queries.

Server-only Prisma is the product data path. Disable public/anonymous direct product-table access. Tenant tables use RLS with a dedicated non-owner, non-BYPASSRLS runtime role: after server authorization, set the workspace context transaction-locally and require it in every tenant-table policy. Retain explicit workspace/site query predicates and composite foreign keys. Never persist tenant context on a pooled connection outside its transaction. Global identity/budget records use narrow server services with actor predicates; dispatch uses a separate restricted operational role for due work metadata, then executes tenant steps in scoped transactions. Neither runtime role can run DDL or modify managed auth tables. Do not pretend Prisma inherits a Supabase JWT. Test unset/wrong context, pooling reuse and site authorization; a compromised server credential can set context, so RLS is defense in depth, not a substitute for authorization. No Supabase service-role key in ordinary browser/product requests.

### 2.1 Auth adapter and permission contract

Planning interfaces, to be implemented once:

```ts
type Actor = {
  userId: string; sessionId: string; authProvider: 'supabase' | 'better-auth';
  authenticatedAt: string; mfaVerified: boolean; securityVersion: number;
};
type Action = 'read' | 'run' | 'edit' | 'export' | 'manage-members' |
  'manage-integrations' | 'manage-billing' | 'delete-workspace' | 'staff-mutate';
// Both throw a structured error on denial; no caller-supplied Actor is trusted.
declare function resolveActor(request: Request): Promise<Actor>;
declare function authorize(actor: Actor, action: Action,
  scope: { workspaceId: string; siteId?: string }): Promise<void>;
```

OWNER has all workspace actions. ADMIN manages members/sites/integrations but cannot create/remove an OWNER, transfer/delete the workspace or change billing. EDITOR can read/run/edit/export only granted sites; VIEWER can read/export only granted sites. Read-only API tokens intersect their explicit scopes with the current issuer's permissions and site grants. Revocation, suspension and deletion are rechecked on every access, export and execution boundary.

Verify provider identity/session server-side; check authoritative membership, session existence, suspension and MFA. Positive auth results may be reused within one request only. Every staff request requires an explicit staff grant and verified MFA; mutations also need the approved fresh authentication. Staff read permission does not grant raw customer-content access. Product security version invalidates outstanding product API tokens/step-up authorizations when recovery requires it.

Use provider-managed sessions; no second token issuer. Apply the approved 30-day maximum, seven-day refresh inactivity, 15-minute Supabase JWT, ten-minute step-up and OTP policy. Phase-one live-session validation must establish creation and last successful refresh from supported authoritative metadata, not JWT `iat` or browser clicks. If Free-plan metadata cannot enforce the approved contract, treat hosted real-data testing as blocked until an explicit resolution; do not silently approximate inactivity or buy Pro. Controlled fixture tests can proceed after build authorization. Better Auth maps the same policy before production, with separate server-side MFA enforcement after Google and email OTP.

Step-up grants: single-use, hashed random token, tied to actor/session/action/resource, expires in ten minutes, consumed atomically with the sensitive mutation. It records a verified authentication event; refreshing a JWT cannot issue a grant. Supabase/Better Auth still issue and verify first/second factors. Keep recovery to backup TOTP and the approved operator-reviewed 72-hour minimum hold; notify verified channels before/after, revoke sessions/tokens on completion, and permit factor replacement only until required MFA is restored.

Invitations are single-use hashed tokens, expire after seven days, bind workspace/site/role and the verified invited email. Invitation acceptance cannot bypass the phase-one allowlist or enrolled MFA. Recheck inviter permission and destination role at acceptance. Do not infer staff membership from invitations.

### 2.2 Better Auth migration contract

Phase 1 already uses stable ProductUser IDs and provider mappings. In phase 2: freeze new auth linking/invitations and mutations during the cutover window; back up and reconcile identities/ownership/budgets; import supported identity records into separately owned Better Auth tables; preserve Google provider subjects. Email-only users establish a fresh verified OTP session and bind through the verified migration mapping, not arbitrary email matching. Ambiguous/duplicate identities enter operator review without access grants.

Invalidate old sessions; activate one auth authority at a time. MFA-enrolled accounts remain gated until safely migrated factors or a verified re-enrollment flow succeeds. Counts, retention, deletion and budgets do not reset. Rehearse rollback with the old provider disabled during forward validation; rollback invalidates new sessions and reconciles any accepted product writes. Never roll product data back merely to undo auth configuration. No MFA bypass or password requirement is introduced by sample migration code.

## 3. API contracts and operation states

Use `/api/v1/visibility` for product APIs. Zod rejects unknown mutation fields and validates IDs, enums and bounded input. Cookie-auth mutations require exact trusted Origin plus anti-CSRF validation; OAuth uses state/PKCE and exact callback URLs. Signed provider callbacks have separate signature validation and no cookie authority. Phase-one preview routes are protected by the private-access boundary even though the eventual public preview works without signup.

| Method/path | Request and result |
| ----------- | ------------------ |
| POST `/previews` | `{url}` → 202 `{operationId,resultToken}`; no AI; token stored hashed |
| POST `/sites` | `{workspaceId,origin,displayName}` → site, verification challenge |
| POST `/sites/:id/verify` | `{method:'dns'|'file'}` → verified state; server fetches proof |
| POST `/sites/:id/discover` | `{}` → 202 operation; bounded candidate list |
| POST `/audits` | `{siteId,urls,methodologyVersion}` → 202; freezes manifest |
| GET `/audits/:id` | Authorized lifecycle/result; no private source bodies by default |
| POST `/audits/:id/rerun` | `{mode:'same-scope'}` → new operation, new idempotency key |
| POST `/operations/:id/cancel` | `{}` → durable cancellation request and current status |
| POST `/content-jobs` | `{siteId,kind,inputRefs,expectedRevision}` → generation operation |
| POST `/research-jobs` | `{siteId,objective,language,freshness}` → research operation |
| POST `/observation-runs` | `{siteId,panelVersionId,surfaces,promptIds}` → parent run and individual jobs/reservations |
| GET `/operations/:id` | `{status,stage,counts,updatedAt,resultRef,error,retryAt}` |
| POST `/exports` | `{siteId,resultId,format,brandingVersion}` → cached result or 202 |
| POST `/integrations/:id/disconnect` | `{expectedVersion}` → immediate revocation and purge operation |

Retain `/audits/:id/cancel` as the audit-scoped wrapper around operation cancellation and GET `/audits/:id/report` as authorized cached retrieval. The editorial-reviews endpoint in the PRD delegates to the same content-job handler; no duplicate generation implementation. Internal job APIs are not public API-token capabilities. GET downloads checks current authorization and returns a signed URL lasting at most five minutes.

Mutation idempotency: caller supplies a UUID `Idempotency-Key`; unique `(actorId,workspaceId,route,key)` stores canonical body hash. Same key/body returns the original operation; changed body returns 409. Retain keys for the operation's retained lifetime, at least 30 days; deletion retains only permitted minimal replay tombstones. API error envelope: `{code,message,requestId,retryable,retryAt?}`. Codes: VALIDATION_ERROR/400, UNAUTHENTICATED/401, FORBIDDEN/403, NOT_FOUND/404 (including inaccessible resource IDs), CONFLICT/409, INPUT_EXPIRED/410, CAPACITY_LIMIT/429, BUDGET_EXHAUSTED/409, PROVIDER_UNAVAILABLE/503. No raw provider bodies or secrets in errors.

Persistent states: QUEUED, RUNNING, WAITING_PROVIDER, RECONCILING, COMPLETED, PARTIAL, FAILED, CANCELLED, EXPIRED. `stage` distinguishes acquiring/evaluating/generating/exporting; `cancelRequestedAt` is independent. Only a contract-valid output becomes COMPLETED. A usable incomplete audit becomes PARTIAL with coverage; incomplete generation is a visible draft, not a successful paid deliverable. Terminal results are immutable; a retry after terminal failure creates a linked new operation and new explicit reservation.

## 4. Admission, queue reliability and cost

Admission runs in a short database transaction: authorize, validate retained source/verification, lock combined and provider budget rows in stable order, check committed plus actual spend and applicable observation counts, create operation/reservations and outbox. Use serializable or equivalent explicit row locks; retry serialization conflicts up to three times with jitter, without external calls inside the transaction. Initial schema creates all provider-period rows together to avoid first-use races.

Costs use PostgreSQL `numeric(20,9)` USD; parse vendor decimal strings without JS floating point. Outbound receipts retain currency/tariff/version. Convert non-USD costs only using a recorded conservative rate/fee policy; until such a policy is verified, do not admit that live paid operation. Reserve the complete possible cost including retries/tool calls. Unknown maximum cost means unavailable admission, not an invented $0 tariff.

The budget owner is the initiating admitted product user, fixed across sites/workspaces and retries. Period is the UTC month at admission. In-flight commitments remain attributed to that period across rollover; do not renew reservations on the first day. Future schedules have an explicit owner who must still be a permitted member. Cancellation or deletion never erases unavoidable provider spend. $8 Azure/$1 Parallel/$1 DataForSEO, combined $10, 25 API and 100+100 consumer observations are independent upper bounds; no editorial/helper/research count meter or 90% stop.

Outbox dispatch claims up to 20 due rows with short locks and publishes reference-only messages `{version:1,operationId,stepId}`. Duplicate messages are normal. Step leases use a 90-second expiry, renewal every 30 seconds and monotonic fencing token; every final write checks the token. Node job-step endpoints use the same fence. Do not hold a consumer open for long provider tasks. The dispatcher runs each minute; outbox/expired-lease reconciliation every five minutes recovers lost messages from database state, even after Queue retention expires.

Persist an attempt intent before sending and the provider receipt immediately after acceptance. A crash between remote acceptance and receipt is ambiguous: reconcile by provider request/task key when supported; otherwise RECONCILING, retain the reservation and require a safe decision rather than blindly replay. At most one transient retry or schema repair for Azure/Parallel; at most two page retries; no retry of permanent blocks. Observations are not retried because of an unfavorable valid answer. Use authenticated polling initially rather than a new inbound callback endpoint. Known DataForSEO tasks are polled with backoff 15s,30s,60s, then up to five-minute intervals; after one hour show delayed/reconciling, keep checking the known task up to provider retention, and never auto-purchase a replacement solely for lateness.

Queued unstarted work expires after 24 hours and releases reservations. Accepted uncertain work cannot be auto-released on that deadline. Daily reconciliation records definitive charges or a conservative bounded charge if the provider cannot resolve billing by month close; adjustments are append-only and source-attributed. Initial settlement uniqueness `(operationId,provider)` prevents internal double accounting; later adjustment entries use unique provider-receipt/reconciliation IDs and record the signed difference, never repeat the full charge. External exactly-once calls are not promised. Cancel stops new paid steps; accepted calls can finish and incur cost, but deleted scopes cannot receive saved outputs.

Initial concurrency: one audit per site, one active expensive operation per budget owner, one active audit per workspace in free mode. These are queueing controls, not monthly entitlements. Batch maximum ten sites per submission, each with independent permission/reservation. Fair dispatch rotates eligible workspaces; no batch bypass. Preview abuse defaults remain three/client/day, ten/origin/day, one active/client; use daily keyed client hashes. Provider browser budget remains eight-minute internal admission target against ten documented free minutes; enforce elapsed runtime and refuse work when safe capacity is unavailable.

## 5. Provider and content execution bounds

Select the existing token/time/size bounds in usage-policy section 2 as initial engineering defaults, including 5 MiB raw HTML, 10 MiB rendered DOM and 2 MiB robots/sitemap documents. They are maximum processing sizes, not negative SEO findings. The table's dollar guards remain illustrations only; actual verified tariffs determine reservations. Sol medium for substantive generation, Luna low for helpers, with no automatic escalation or fallback. Unsupported effort/tool settings block that operation pending verification.

One Azure client; two configured deployment names. Editorial requests have no tools and only authorized selected evidence. Prompt inputs and citations reference immutable source IDs; output schema includes text, supporting source IDs and labelled assumptions. Reject unknown source references and fabricated citations. Escape untrusted source text as data; no source instructions can choose URLs, credentials, tools or scope. An optimistic `expectedRevision` prevents overwriting simultaneous edits; preserve the user's unsaved draft on conflict.

Research: one Search plus up to ten explicit Extract URLs per step; excerpts first, completed snapshots only, cache reuse at most 24 hours within the same workspace/configuration. A longer brief composes only approved bounded inputs; exceeding limits returns a visible scope choice, not hidden truncation. Save artifact metadata and minimum cited excerpts for retained work; expired full inputs are unavailable for fresh generation.

Azure observation uses Sol with the fixed verified web-search configuration; no direct OpenAI, Gemini, Claude or Perplexity API fallback. DataForSEO uses Standard ChatGPT/Gemini; Live is disabled for the default pilot. Responses versus Scraper endpoints remain distinct. Verify actual model identifiers, locale capability, terms, search-request cost bounds and receipt semantics before real measurements. Simulations are labelled synthetic and never mixed into real cohorts.

## 6. Site acquisition and integrations

Canonical URL normalization: HTTPS only; reject userinfo, nondefault ports, IP-literal/private/reserved destinations, malformed/oversized URLs and sensitive preview query values. Lowercase IDNA hostname, remove fragment/default port, resolve dot segments, normalize percent-encoding of unreserved characters, preserve path case/trailing slash/query ordering and repeated parameters. Do not strip arbitrary query parameters or conflate `/a` and `/a/`. Stable manifest order sorts normalized URL strings. Max URL length 2048 characters and max five redirects; full-audit redirects leaving the verified origin are not followed for content acquisition.

DNS TXT or exact-origin file challenges use 32-byte random tokens stored hashed, expire after 24 hours, and bind workspace/origin. Reverify before each full audit; a recent successful check within 24 hours may be reused. Revoked/failed verification blocks new crawl dispatch. Robots/sitemaps/raw fetches and every browser navigation/redirect/subresource require enforceable public-network restrictions, including IPv4/IPv6/rebinding. A preflight lookup alone is not sufficient. If Browser Run cannot establish the necessary boundary, live crawling stays blocked; no fallback provider or weakened scope is selected.

GSC: read-only separate OAuth, encrypted refresh credentials, property chooser validated against provider access. Initial backfill 90 days; daily integration refresh of the latest seven provider dates. Paginate with a 100,000-row per property/day/query-shape processing ceiling; reaching it marks that dataset partial, never exhaustive. Do not sum overlapping dimension datasets. CTR = clicks/impressions; position aggregates only compatible provider summaries weighted by impressions. Zero impressions yields null CTR/position. Disconnect stops imports and purges imported data under the approved seven-day target. Token loss shows reconnect, including Testing-mode expiry.

Customer outbound webhooks: event ID/type/version/time plus minimal resource IDs, never raw content; HMAC-SHA256 over `timestamp + '.' + rawBody`. Receiver guidance checks signature and ±5-minute timestamp window, deduplicates event IDs. New timestamp/signature per retry; same event ID. HTTPS public destinations only, no redirects, revalidate each attempt; 10-second timeout and 64 KiB response ceiling. Retry transient/network/429/5xx at 1m,5m,30m,2h,12h, then mark failed; 4xx except429 is terminal. The configured secret is encrypted; rotation has at most 24h overlap, explicit revocation immediate.

Read-only API tokens: 32 random bytes, show once, store hash, 90-day default expiry, explicit scopes/site grants, 60 requests/minute/token initial operational bound, no raw source/credentials/billing writes. Tokens never exceed current issuer permissions or bypass phase-one private access. Staff mutations require interactive MFA, never a customer API token.

WordPress: dedicated least-privilege credential, validated public endpoint, explicit draft creation only. Store destination and request hash before POST. Persist returned post ID and use it for subsequent updates. An uncertain accepted POST with no provider reconciliation path remains unresolved for manual inspection; never blindly retry creation or promise native deduplication from a local key. Show a link to a confirmed draft; disconnect revokes future delivery and does not delete external drafts.

Gmail: Supabase issues OTPs; server-only Node SMTP sends product invitations/notices. Email outbox references template/purpose/recipient IDs, renders at delivery after permission checks, excludes OTP/body logs, and respects validity/deadlines. SMTP unknown acceptance is not proof of failure; avoid automatic duplicate sends of security actions. Phase 2 swaps delivery to verified Brevo, not the OTP authority contract. No tracking pixels or unsolicited bulk messages.

PDF/CSV/HTML: render only authorized stored results; cache keys include result/hash, template, locale and branding version. PDF renderer has no network fetch; approved logo/font bytes and validated bounded raster branding are loaded locally. Reject active SVG/HTML uploads. CSV quotes cells and prefixes an apostrophe when first non-whitespace/control character is `=`, `+`, `-` or `@`; test tabs/CR/LF. HTML/Markdown renderer disables embedded raw HTML and unsafe protocols; JSON-LD exports are data, not executable script injected into the app.

## 7. Billing, deletion and operations

Phase 1 implements sandbox event/state contracts with test-only price IDs, no invented public prices. Verify signatures on exact raw bodies, unique `(provider,eventId)`, reconcile out-of-order events against provider state, and transact entitlements. States: NONE, PENDING, ACTIVE, PAST_DUE, CANCEL_AT_PERIOD_END, ENDED, DISPUTED. Event-to-state fixtures cover each provider; a redirect never grants access. Commercial grace/refund policies remain disabled configuration pending later decisions. Sandbox receipts never grant production entitlements.

Deletion blocks access/admission immediately, marks descendants, revokes credentials and enqueues paginated cleanup; all writes/callbacks check tombstones. Retention enforcement applies at reads as well as daily cleanup. Preserve the approved 30-day raw-source/90-day raw-answer/13-month compact/saved-work schedule and seven-day purge target. Never copy expired evidence into another category to evade TTL. Signed downloads max five minutes; object cleanup handles outstanding URLs.

Daily encrypted logical backups and a manifest of non-reproducible saved artifacts retain seven restore points in access-separated storage. Deletion/revocation journal is outside the restorable snapshot; replay it plus current TTLs before reopening access. Restore invalidates all sessions and external credentials unless reconciled against authoritative current state. Reconcile provider costs/tasks before resuming paid dispatch. Private-pilot restoration target remains 24h and up to 24h data loss with successful daily backups; production finance/recovery objectives stay deferred. No PITR purchase implied.

Phase-one admin implements exactly the approved lean scope. Audit staff access/mutations; no impersonation, credit editing, SQL console or secrets. One operator kill switch per expensive module plus a global dispatch pause. Persist redacted failures, queue age, unsettled spend and deletion backlog for operator inspection; no PostHog collection. Required security records follow the approved India archive policy and actual legal verification. Scheduled internal reconciliation and backup are operational work, not deferred customer automation.

## 8. UI/state contract

Use approved Launch Review, final LyraSEO AI logo with AEO/GEO in every L, Manrope/Inter and semantic tokens. Marketing fixed cobalt/white; app/auth/admin/client surfaces Light/Dark/System. Impeccable governs later visual implementation and inspection; no new visual identity decision is opened.

| Surface | Required behavior |
| ------- | ----------------- |
| Private landing/preview | Invitation-only CTA and protected preview; no public checkout or fabricated proof. Eventual public mode uses the same one-page preview contract. |
| Onboarding | Google/OTP → optional/enforced MFA → workspace/site verification → manifest confirmation. GSC/research/panels optional; preserve submitted URL. |
| Audit/results | Real stage/count/time, cancel-request acknowledged, partial coverage visible; selected issue/filter/scroll retained. Review/dismiss never changes score. |
| Content | Evidence beside editable draft; save state/revision conflict visible; explicit generate/research/export/WordPress-draft actions; no automatic paid rerun after auth expiry. |
| Visibility | Separate surface/cohort tabs, valid sample denominator, missing/uncertain status, no-brand distinct from failed; never invent trend evidence. |
| Agency/client | Granted-site navigation only; batch confirmation lists sites and cost reservations. Viewer sees no write controls or unrelated billing. |
| Budget/capacity/error | Show safe reason, remaining budget and next action/retry time. No smaller hidden quota, silent quality downgrade, raw vendor dump or fake countdown. |
| Expiry/deletion | Source unavailable is distinct from deleted saved work; reacquisition requires explicit action; deletion confirmation shows scope/export/retention exceptions. |
| Auth/recovery | Preserve safe navigation/drafts, enforce step-up, show pending/denied/held recovery honestly; never claim notices delivered without receipts. |

All async screens cover initial loading, empty, queued, running, partial, stale, unavailable, failed, cancel-requested, cancelled, expired and permission-lost where meaningful. Poll 2s for first 30s, then 5s to 2min, then 15s while visible; pause hidden-tab polling and refetch on focus. No WebSocket service initially. Tables use cursor pagination; accessible charts include the underlying table. Desktop split view collapses to list/detail on mobile; restore focus/back/scroll. Verify 320/360px, tablet and wide desktop, 200% zoom, keyboard, both themes and reduced motion. Preserve draft text in memory on recoverable errors; no automatic storage of sensitive content in localStorage.

## 9. Phase-two engineering boundaries

After domain ownership and separate authorization, route marketing at apex and auth/APIs/app at `app.lyraseoai.com`; redirect obsolete app links to the canonical app origin without forwarding tokens in query strings. Host-only secure cookies; exact allowed origins and OAuth callbacks. Test root/app-host confusion and prevent private responses caching across hosts/users.

Customer schedules: weekly default, daily optional when future entitlement permits; explicit IANA timezone, local wall time and stable budget owner. One unique `(scheduleId,localDate,slot)` occurrence. On spring DST gap use the first valid local instant after the gap; on fall overlap use the first occurrence. Do not catch up missed slots after outages; record skipped and await the next slot or explicit run. Recheck all permissions, verification, source version, budget and opt-in. Changing panel/manifest/timezone versions affects future occurrences only. Completion/failure/regression/digest notifications require current site permission and preferences; unsubscribe from digests never disables essential security notices.

Advanced admin is phase 2: scoped staff role capabilities, case-authorized time-bounded impersonation with visible banner and no sensitive mutations, reasoned append-only credit adjustments and provider-reconciled refunds, bounded bulk operations with item outcomes, operator dashboards. No arbitrary SQL or secret editor. Enable financial features only after commercial policies and specific permissions exist; public pricing does not need to be invented to specify the audit and authorization contract.

PostHog activates only after its consent/retention/volume choices are settled, with approved explicit events, scrubbed exceptions, no replay/autocapture/content backlog. Phase-two activation requires production auth/MFA migration, email, billing and restore evidence; domain purchase alone is not launch acceptance.

## 10. Verification gates, not unresolved product design

Written contracts are finalized. The first authorized build must verify runtime compatibility, Supabase session metadata, Prisma pooling/transactions, browser isolation/CPU, PDF/SMTP Node execution, Azure tariff/tool bounds, consumer sampling/terms and provider account eligibility. Failed feasibility blocks that live capability; fixtures remain visibly synthetic. Any necessary change to approved vendor, budget, security or feature scope returns to the founder with evidence. No contingency silently buys capacity or removes a retained module.

Primary references checked 2026-10-23: [Supabase sessions](https://supabase.com/docs/guides/auth/sessions), [Cloudflare queue delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), [Prisma transactions](https://www.prisma.io/docs/orm/fundamentals/transactions), [Better Auth two-factor](https://better-auth.com/docs/plugins/2fa). These establish provider boundaries, not successful integration; implementation must use the pinned version's API.
