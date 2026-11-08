import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  acquireRawPage,
  originalBody,
  type PublicTransport,
} from "../../packages/visibility/src/acquisition";

const origin = "https://example.com/";
const withPage =
  (page: PublicTransport): PublicTransport =>
  (url, signal) =>
    url.endsWith("/robots.txt")
      ? Promise.resolve(new Response(null, { status: 404 }))
      : page(url, signal);

it("keeps an internal acquisition timeout distinguishable from an unknown failure", async () => {
  const timedOut = await acquireRawPage(
    origin,
    origin,
    withPage(async () => {
      // Same stable code emitted by the production DNS deadline boundary.
      throw new Error("ACQUISITION_TIMEOUT");
    }),
  );
  expect(timedOut.provenance.error).toBe("ACQUISITION_TIMEOUT");
  expect(timedOut.evidence.acquired).toBe(false);
  const unknown = await acquireRawPage(
    origin,
    origin,
    withPage(async () => {
      throw new Error("private upstream details must not enter a receipt");
    }),
  );
  expect(unknown.provenance.error).toBe("ACQUISITION_FAILED");
  expect(JSON.stringify(unknown)).not.toContain("private upstream details");
});

it("retains a malformed UTF-8 byte digest with an explicit unreadable classification", async () => {
  const bytes = new Uint8Array([0xff]);
  const receipt = await acquireRawPage(
    origin,
    origin,
    withPage(
      async () =>
        new Response(bytes, { headers: { "content-type": "text/html" } }),
    ),
  );
  expect(receipt.provenance.error).toBe("BODY_INVALID_UTF8");
  expect(receipt.provenance.sha256).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(receipt.provenance.rawHtml).toBeUndefined();
  expect(originalBody(receipt)).toEqual(bytes);
  expect(receipt.evidence.acquired).toBe(false);
});

it("refuses unexpected content encodings instead of parsing encoded bytes as HTML", async () => {
  const receipt = await acquireRawPage(
    origin,
    origin,
    withPage(
      async () =>
        new Response(
          "<html><title>Encoded bytes are not an HTML observation</title></html>",
          {
            headers: {
              "content-type": "text/html",
              "content-encoding": "gzip",
            },
          },
        ),
    ),
  );
  expect(receipt.provenance.error).toBe("UNSUPPORTED_CONTENT_ENCODING");
  expect(receipt.evidence.acquired).toBe(false);
  expect(receipt.evidence.titleElements).toEqual([]);
  expect(receipt.provenance.rawHtml).toBeUndefined();
});

it("preserves the observed redirect chain when a later hop is forbidden", async () => {
  const requested: string[] = [];
  const receipt = await acquireRawPage(
    `${origin}start`,
    origin,
    withPage(async (url) => {
      requested.push(url);
      return new Response(null, {
        status: 302,
        headers: {
          location: url.endsWith("/start")
            ? "/next"
            : "https://outside.example/secret",
        },
      });
    }),
  );
  expect(receipt.provenance.error).toBe("REDIRECT_OUTSIDE_ORIGIN");
  expect(receipt.provenance.redirects).toEqual([
    `${origin}start`,
    `${origin}next`,
  ]);
  expect(receipt.provenance.finalUrl).toBeUndefined();
  expect(requested).toEqual([`${origin}start`, `${origin}next`]);
});
