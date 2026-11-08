# Crawler verification

`pnpm test:crawler` runs the required real HTTP crawler contract matrix. It
starts ephemeral loopback fixture servers and maps a fixed HTTPS fixture origin
through the acquisition function's existing injected transport seam. It does
not relax the production public-address policy. CI runs this command in
addition to unit, database, worker and browser tests.

The matrix checks the exact expected failures **and the absence of unexpected
failures** for healthy HTML, malformed but parseable HTML, a JavaScript shell,
403/404/429/5xx responses, empty/malformed UTF-8/encoded/truncated/oversized
bodies, policy failures, redirects, duplicate destinations and header metadata.
It proves the five-redirect boundary, blocks outside-origin, HTTP downgrade and
metadata redirects, checks robots before each page hop, and confirms that raw
acquisition never loads script, style, frame or other subresources. The fixture
adapter uses Node HTTP without redirect following or transparent decompression.
The oversized response is streamed with chunked transfer encoding.

The production acquisition path preserves these distinct unavailable receipts:

| Receipt                        | Meaning                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `ACQUISITION_TIMEOUT`          | Internal acquisition/DNS deadline; no retry is implied.                                 |
| `BODY_INVALID_UTF8`            | Original bytes were read and hashed, but cannot become a UTF-8 source artifact.         |
| `UNSUPPORTED_CONTENT_ENCODING` | The server ignored the identity-encoding request; encoded bytes are not parsed as HTML. |
| `REDIRECT_OUTSIDE_ORIGIN`      | A redirect leaves the verified HTTPS origin, including a downgrade.                     |
| `REDIRECT_INVALID_LOCATION`    | A same-origin redirect cannot be normalized safely.                                     |
| `ACQUISITION_FAILED`           | Other unavailable transport/body failures; untrusted exception details are omitted.     |

Unavailable receipts retain observed HTTP facts where available. A forbidden
redirect retains up to five observed authorized redirect hops; an unrequested
destination is never labelled as a fetched final URL. Sponsor cancellation
propagates before checkpointing. An internal deadline instead returns an
unavailable receipt that can be checkpointed.

`tests/integration/crawler-contract.test.ts` runs the same HTTP fixture through
the authorized production raw step and real restricted PostgreSQL checkpoint
functions. It reconnects the runtime database client between pages, checks that
completed evidence is not fetched again, and compares a fixed HTTP defect with
a newly unreadable and a persistently unreadable page. Only the actual HTTP fix
resolves; missing evidence remains `UNKNOWN`. These tests run with the normal
`pnpm test:integration` gate.

`tests/unit/public-transport.test.ts` separately verifies public/mixed/private
DNS rejection, pinned socket lookup, original hostname/TLS behavior and the
post-DNS authorization barrier. Its HTTPS socket is mocked, so neither that
test nor the mapped local HTTP fixture proves a deployed public TLS path.

## Rendered acquisition remains unavailable

These are **raw HTTP** tests. JavaScript is not executed, visibility and
accessibility are unobserved, and raw HTML does not qualify a numeric readiness
score. The existing raw-only checkpoint rejects rendered evidence; this harness
does not change its profile or scoring methodology.

The selected hosted renderer is still unqualified. No hosted browser session,
paid provider request or cloud deployment is part of this gate. Enabling a
controlled rendered profile requires an unprivileged sandboxed Chromium and a
kernel-enforced network boundary that routes every permitted request through
the approved TLS-aware gateway, with independent deny canaries and cleanup
receipts. Playwright interception alone does not provide that boundary. The
local safe image inspected during this tranche contained neither Chromium nor
firewall tooling; no privileged container, host-network exception or unrelated
product image was used to work around the gap.

Live TLS/redirect/subresource isolation, browser capacity, rights and account
qualification remain separate acceptance gates. The fixture results must not
be presented as hosted or rendered measurements.
