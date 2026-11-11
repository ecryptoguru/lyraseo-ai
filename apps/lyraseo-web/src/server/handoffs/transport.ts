import { request } from "node:https";
import { resolvePublicAddress } from "../acquisition/transport";
import {
  outboundUrl,
  signWebhook,
  wordpressRequest,
  sha256,
} from "@lyraseo/db/handoff-codecs";
export type PostResult = { status: number; body: string };
async function checkBeforeSocket(
  check: () => Promise<void>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(Error("HANDOFF_ABORTED"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([check(), cancelled]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
/** No live admission is wired to this adapter. Call only after a qualified action supplies beforeSocket. */
async function post(
  urlValue: string,
  body: string,
  headers: Record<string, string>,
  beforeSocket: () => Promise<void>,
  signal: AbortSignal,
): Promise<PostResult> {
  const url = new URL(urlValue);
  // The WordPress adapter is the only caller permitted to add its fixed fields query.
  outboundUrl(url.origin + url.pathname);
  await checkBeforeSocket(beforeSocket, signal);
  const address = await resolvePublicAddress(url.hostname, signal);
  await checkBeforeSocket(beforeSocket, signal);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        agent: false,
        family: address.family,
        signal,
        maxHeaderSize: 16384,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
          Accept: "application/json",
          "Accept-Encoding": "identity",
          "User-Agent": "Lyraseo-Private-Handoff/1.0",
          ...headers,
        },
        lookup: (_hostname, _options, callback) =>
          callback(null, address.address, address.family),
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const status = incoming.statusCode;
        if (!status || status < 200 || status > 599) {
          incoming.destroy();
          reject(Error("INVALID_UPSTREAM_STATUS"));
          return;
        }
        // Never follow a redirect or return its potentially credential-bearing Location.
        if (status >= 300 && status <= 399) {
          incoming.destroy();
          resolve({ status, body: "" });
          return;
        }
        if (
          incoming.headers["content-encoding"] &&
          incoming.headers["content-encoding"] !== "identity"
        ) {
          incoming.destroy();
          reject(Error("UNSUPPORTED_ENCODING"));
          return;
        }
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65536) {
            incoming.destroy(Error("RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("aborted", () => reject(Error("RESPONSE_ABORTED")));
        incoming.on("end", () =>
          resolve({ status, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
/** Sends the reviewed, hashed bytes; a renderer upgrade cannot change a queued draft. */
export async function wordpressFrozenDraftPost(
  input: {
    installation: string;
    origin: string;
    body: string;
    bodyHash: string;
    username: string;
    applicationPassword: string;
  },
  beforeSocket: () => Promise<void>,
  signal: AbortSignal = AbortSignal.timeout(10000),
) {
  if (
    !input.username ||
    input.username.length > 200 ||
    /[:\r\n]/.test(input.username) ||
    !input.applicationPassword ||
    input.applicationPassword.length > 1024 ||
    /[\r\n]/.test(input.applicationPassword) ||
    Buffer.byteLength(input.body) > 524288 ||
    sha256(input.body) !== input.bodyHash
  )
    throw Error("INVALID_WORDPRESS_REQUEST");
  const value = wordpressRequest(input.installation, input.origin, {
      title: "Endpoint",
      body: "",
    }),
    parsed = JSON.parse(input.body);
  if (
    Object.keys(parsed).sort().join(",") !== "content,status,title" ||
    parsed.status !== "draft" ||
    typeof parsed.title !== "string" ||
    parsed.title.length < 1 ||
    parsed.title.length > 200 ||
    typeof parsed.content !== "string" ||
    !parsed.content.startsWith("<p>") ||
    !parsed.content.endsWith("</p>") ||
    /[<>]/.test(parsed.content.replace(/<\/?p>/g, ""))
  )
    throw Error("INVALID_WORDPRESS_REQUEST");
  return post(
    value.url,
    input.body,
    {
      Authorization: `Basic ${Buffer.from(`${input.username}:${input.applicationPassword}`).toString("base64")}`,
    },
    beforeSocket,
    AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  );
}
export async function wordpressDraftPost(
  input: {
    installation: string;
    origin: string;
    title: string;
    body: string;
    username: string;
    applicationPassword: string;
  },
  beforeSocket: () => Promise<void>,
  signal: AbortSignal = AbortSignal.timeout(10000),
) {
  if (
    !input.username ||
    input.username.length > 200 ||
    /[:\r\n]/.test(input.username) ||
    !input.applicationPassword ||
    input.applicationPassword.length > 1024 ||
    /[\r\n]/.test(input.applicationPassword)
  )
    throw Error("INVALID_WORDPRESS_CREDENTIAL");
  const value = wordpressRequest(input.installation, input.origin, input);
  return wordpressFrozenDraftPost(
    { ...input, body: value.body, bodyHash: value.hash },
    beforeSocket,
    signal,
  );
}
export async function signedWebhookPost(
  input: {
    url: string;
    body: string;
    key: string;
    keyId: string;
    eventId: string;
    previousKey?: string;
    previousKeyId?: string;
  },
  beforeSocket: () => Promise<void>,
  signal: AbortSignal = AbortSignal.timeout(10000),
) {
  const url = outboundUrl(input.url),
    timestamp = Math.floor(Date.now() / 1000),
    event = JSON.parse(input.body);
  if (Buffer.byteLength(input.body) > 16384 || event.id !== input.eventId)
    throw Error("INVALID_EVENT");
  const headers: Record<string, string> = {
    ...signWebhook(input.body, input.key, input.keyId, timestamp),
    "X-Lyraseo-Event-Id": input.eventId,
  };
  if (input.previousKey && input.previousKeyId) {
    const previous = signWebhook(
      input.body,
      input.previousKey,
      input.previousKeyId,
      timestamp,
    );
    headers["X-Lyraseo-Previous-Key-Id"] = input.previousKeyId;
    headers["X-Lyraseo-Previous-Signature"] = previous["X-Lyraseo-Signature"];
  }
  return post(
    url,
    input.body,
    headers,
    beforeSocket,
    AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  );
}
