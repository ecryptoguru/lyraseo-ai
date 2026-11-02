# Local Queue carrier — deployment UNQUALIFIED

This carrier transports `{version:1,workId,generation}` references. It has no DB,
provider, browser actor or target acquisition dependency. The signed Node bridge
owns authorization and durable steps. `claimToken` travels only in the private
HTTP control exchange and is never sent to a Queue or logged.

Both configuration switches default to `false`. The default environment has no
Queue bindings, routes or Cron triggers; `workers_dev` and preview URLs are off.
`local` defines local Queue/DLQ bindings and finite retry controls for testing.
No cloud resource or secret has been configured. Do not deploy this local env.

From the repository root, after dependency installation and `pnpm db:local`:

```sh
pnpm --filter @lyraseo/worker generate-types
pnpm --filter @lyraseo/worker typecheck
pnpm --filter @lyraseo/worker test
pnpm test:worker
```

The direct worker suite skips HTTP/DB interop without the supervisor. The root
command must pass with no interop skips. It validates the existing loopback
PostgreSQL 17 container, creates a random `lyraseo_worker_*` database, applies all
accepted migrations, enrolls that database as disposable, boots B with a restricted
dispatch connection, and starts workerd tests. It owns/cleans the database and
listener/test process groups. It never resets the canonical `lyraseo_test` DB.
Existing local restricted roles and the generated Prisma client are prerequisites;
there is no cloud or credential fallback.

The test-only Miniflare outbound mapper permits only the synthetic HTTPS bridge
origin and the supervisor's control origin, preserving signed method/path/bytes/
headers. It forwards to B's current ephemeral loopback listener and changes Host
only through the HTTP client's normal target-host behavior. The production origin
validator has no loopback exception. The native binding test intercepts the main
handler in the test isolate to observe actual Queue JSON; native DLQ exhaustion
keeps five retries but substitutes zero wait time after asserting the carrier's
60-second delay argument. No deployed retention or timing behavior is claimed.

Control HTTP calls have an 8-second deadline, Queue sends 5 seconds, one combined
Cron invocation 25 seconds, and a step 47 seconds (B caps its handler at 45).
There is at most one dispatch reference/tick and one executed step/batch; every
extra message is explicitly retried. Cron `* * * * *` skips five-minute boundaries;
`*/5 * * * *` runs recovery(limit 20) then one dispatch(limit 1). A failure remains
observable even if the other branch succeeds. No faster recursive handoff exists.
Lost dispatch/ack responses may replay the exact fresh envelope once; expired
IDs are never timestamp-refreshed. Paid work cannot be admitted by this carrier.

A future reviewed deployment environment must define its own explicit producer,
consumer and named DLQ (bindings are not inherited), serial limits, both Cron
expressions above, and required secret names. It must remain disabled until a
separately designed fixed HTTPS Node front door, raw-target/header integrity,
ingress authentication, key rotation/storage, lifecycle supervision, DB policy,
account Queue/Cron/DLQ availability, capacity/cost/retention, telemetry redaction,
kill switch, recovery and rollback pass qualification and deployed acceptance.
B currently has only a controlled injected listener, so changing `BRIDGE_ORIGIN`
cannot qualify hosted Node, TLS/egress or live-site/provider execution.

`BRIDGE_SECRET` is a secret binding containing canonical unpadded base64url bytes,
at least 32 decoded bytes. `BRIDGE_KEY_ID`, principal, audience and HTTPS origin
come from trusted configuration. The allowed paths and identity are fixed to the
accepted B protocol. Never put key material in config source, messages or logs.

Round 1 adds a separate acceptance journey that invokes the production scheduled
export, delivers through the native binding, and observes while delegating to the
original production queue export with an enabled test-only Env. Only retriable
waits are shortened (60 seconds asserted, one second used); no native message is
acknowledged by the observer. The prior isolated binding/policy tests remain.

The Node-only mapper now requires a bounded per-run endpoint pin file issued over
supervisor IPC into an owned private temporary directory. Candidate environment
origins must exactly match issued canonical loopback origins. A restart response
must match an independently updated pin and the next version. Only the five B
POST paths and fixed control GET paths are permitted; redirects and unissued
ports are rejected. The pin file has no secrets. Two independent ephemeral
rotation keys travel only over IPC/test process bindings, never HTTP or Queue
payloads. The root worker command also runs the Node mapper/ownership tests.
