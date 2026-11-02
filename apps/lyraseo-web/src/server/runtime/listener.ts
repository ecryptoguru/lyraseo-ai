// Controlled B harness only. Nothing imports this module from the web app,
// starts a listener at boot, opens a database from env or provisions a key.
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { auditErrorCode, runBridgeControl } from "@lyraseo/db/bridge";
import type { createDatabase } from "@lyraseo/db";
import {
  authenticateRuntime,
  parseRuntimeBody,
  runtimeBodyLimit,
  runtimePaths,
  type RuntimePath,
  type RuntimeKey,
} from "@lyraseo/contracts/runtime-signing";
import { type ControlledFixture, isControlledFixture } from "./fixture";
import { signedStep } from "./step";

type Options = {
  db: ReturnType<typeof createDatabase>;
  keys: () => readonly RuntimeKey[];
  fixture: ControlledFixture;
  /** Optional stricter, server-injected ceiling for the isolated harness. */
  handlerBudgetMs?: number;
};
const reject = (): never => {
  throw new Error("INVALID_REQUEST");
};
function wireHeaders(req: IncomingMessage) {
  const h = new Headers(),
    seen = new Set<string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase();
    if (seen.has(name)) reject();
    seen.add(name);
    h.set(name, req.rawHeaders[i + 1]!);
  }
  if (
    h.has("content-encoding") ||
    h.has("x-http-method-override") ||
    h.has("x-method-override") ||
    h.has("x-original-url") ||
    h.has("x-rewrite-url") ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      h.get("content-type") ?? "",
    )
  )
    reject();
  return h;
}
async function readBytes(
  req: IncomingMessage,
  max: number,
  signal: AbortSignal,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  if (
    req.headers["content-length"] &&
    Number(req.headers["content-length"]) > max
  )
    reject();

  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > max) reject();
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
function send(res: ServerResponse, status: number, result: unknown) {
  if (res.destroyed || res.headersSent) return;
  let body = JSON.stringify(result);
  if (Buffer.byteLength(body) > 32768) {
    status = 503;
    body = '{"error":"UNAVAILABLE"}';
  }
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
    Connection: "close",
  });
  res.end(body);
}
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  host: string,
  opts: Omit<Options, "handlerBudgetMs">,
  budget: number,
) {
  const path = req.url as RuntimePath;
  if (!runtimePaths.includes(path))
    return send(res, 404, { error: "NOT_FOUND" });
  if (req.method !== "POST")
    return send(res, 405, { error: "METHOD_NOT_ALLOWED" });
  const deadline = new Date(Date.now() + budget);
  const abort = new AbortController(),
    signal = abort.signal;
  const timer = setTimeout(() => {
    // Return on the wall clock even when a pool/driver call is still unwinding.
    // Close an unfinished request body only after its error response is flushed.
    if (!req.complete) res.once("finish", () => req.destroy());
    send(res, 503, { disposition: "RETRY" });
    abort.abort(new Error("HANDLER_DEADLINE"));
  }, budget);
  res.once("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  let authenticated = false;
  try {
    const h = wireHeaders(req);
    if (
      h.get("host") !== host ||
      req.socket.remoteAddress !== "127.0.0.1" ||
      h.has("forwarded") ||
      h.has("x-forwarded-host") ||
      h.has("x-forwarded-proto")
    )
      reject();
    const bytes = await readBytes(req, runtimeBodyLimit(path), signal);
    const envelope = await authenticateRuntime(path, h, bytes, opts.keys());
    const assertSigner = () => {
      envelope.assertCurrentSigner(opts.keys());
      signal.throwIfAborted();
      if (Date.now() >= deadline.getTime()) throw new Error("HANDLER_DEADLINE");
    };
    authenticated = true;
    assertSigner();
    parseRuntimeBody(path, envelope.rawBody);
    signal.throwIfAborted();
    const outcome =
      path === runtimePaths[3]
        ? await signedStep(
            opts.db,
            envelope,
            opts.fixture,
            signal,
            deadline,
            assertSigner,
          )
        : await runBridgeControl(
            opts.db,
            path,
            envelope,
            deadline,
            assertSigner,
          );
    assertSigner();
    send(res, 200, outcome);
  } catch (error) {
    if (!authenticated)
      return send(res, 401, { error: "INVALID_AUTHENTICATION" });
    // Do not echo database diagnostics, proofs, bodies, URLs or claim tokens.
    const msg = auditErrorCode(error) ?? "";
    if (msg === "SIGNER_REVOKED")
      return send(res, 401, { error: "INVALID_AUTHENTICATION" });
    if (msg === "REQUEST_CONFLICT")
      return send(res, 409, { error: "REQUEST_CONFLICT" });
    if (
      /^(HANDLER_DEADLINE|RETRY_FRESH|RETRY_DELIVERY|LEASE_BUSY|PAUSED|STALE_ATTEMPT|CHECK_UNAVAILABLE|STALE_LEASE|FORBIDDEN|SITE_NOT_VERIFIED)$/.test(
        msg,
      )
    )
      return send(res, 503, { disposition: "RETRY" });
    if (/^(STALE_TARGET|AUDIT_TERMINAL)$/.test(msg))
      return send(res, 200, { disposition: "STALE" });
    if (msg === "INVALID_REQUEST")
      return send(res, 400, { error: "INVALID_REQUEST" });
    return send(res, 503, { error: "UNAVAILABLE" });
  } finally {
    clearTimeout(timer);
  }
}
export async function startControlledRuntime(opts: Options) {
  const budget = opts.handlerBudgetMs ?? 45000;
  // Keep startup-only dependencies fixed. Resolve the signing provider on
  // its original receiver each time so rotation and replacement take effect.
  const runtime = {
    db: opts.db,
    fixture: opts.fixture,
    keys: () => opts.keys(),
  };
  if (
    !Number.isInteger(budget) ||
    budget < 1 ||
    budget > 45000 ||
    !runtime.keys().length ||
    !isControlledFixture(runtime.fixture)
  )
    throw new Error("CONTROLLED_CONFIGURATION_REQUIRED");
  let host = "";
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 45000, headersTimeout: 10000 },
    (req, res) => void handle(req, res, host, runtime, budget),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  host = "127.0.0.1:" + (server.address() as AddressInfo).port;
  return {
    origin: "http://" + host,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  };
}
