import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { Readable } from "node:stream";
import ipaddr from "ipaddr.js";
import { normalizeUrl } from "@lyraseo/visibility/url";
import { CRAWLER_AGENT } from "@lyraseo/visibility/acquisition";

/** Every resolved address must be public. The selected address is pinned to the socket. */
export async function resolvePublicAddress(
  hostname: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("ACQUISITION_TIMEOUT"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      cancelled,
    ]);
    if (
      !addresses.length ||
      addresses.some(
        (entry) =>
          !ipaddr.isValid(entry.address) ||
          ipaddr.process(entry.address).range() !== "unicast",
      )
    )
      throw new Error("DESTINATION_BLOCKED");
    return addresses[0]!;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Node-only raw HTTP acquisition. No scripts, subresources, credentials, proxies or redirects. */
export async function publicHttpsTransport(
  value: string,
  signal: AbortSignal,
): Promise<Response> {
  const url = new URL(normalizeUrl(value));
  const address = await resolvePublicAddress(url.hostname, signal);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        agent: false,
        family: address.family,
        signal,
        maxHeaderSize: 16 * 1024,
        headers: {
          "user-agent": CRAWLER_AGENT,
          accept: "text/html,text/plain,application/xml;q=0.9",
          "accept-encoding": "identity",
        },
        // Keep original hostname for Host and TLS verification while avoiding a second DNS lookup.
        lookup: (_hostname, _options, callback) =>
          callback(null, address.address, address.family),
      },
      (incoming) => {
        try {
          const status = incoming.statusCode;
          if (!Number.isInteger(status) || status! < 200 || status! > 599)
            throw new Error("INVALID_UPSTREAM_STATUS");
          const headers = new Headers();
          for (const [name, values] of Object.entries(incoming.headers)) {
            if (values !== undefined && name !== "set-cookie")
              headers.set(
                name,
                Array.isArray(values) ? values.join(", ") : values,
              );
          }
          if ([204, 205, 304].includes(status!)) {
            incoming.resume();
            resolve(new Response(null, { status: status!, headers }));
          } else {
            resolve(
              new Response(
                Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
                { status: status!, headers },
              ),
            );
          }
        } catch (error) {
          incoming.resume();
          reject(error);
        }
      },
    );
    req.on("error", reject);
    req.end();
  });
}
