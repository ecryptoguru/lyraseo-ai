// Node-test side only. Never imported into the workerd isolate or production.
import {
  openSync,
  readSync,
  closeSync,
  writeFileSync,
  renameSync,
} from "node:fs";
export function loopbackOrigin(value) {
  if (typeof value !== "string") throw Error("INVALID_TEST_ENDPOINT");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("INVALID_TEST_ENDPOINT");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    Number(url.port) < 1024 ||
    url.origin !== value ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error("INVALID_TEST_ENDPOINT");
  return value;
}
export function validatePins(pins) {
  if (
    !pins ||
    typeof pins !== "object" ||
    Object.keys(pins).sort().join(",") !== "bridge,control,version" ||
    !Number.isSafeInteger(pins.version) ||
    pins.version < 1 ||
    pins.version > 1000000
  )
    throw Error("INVALID_TEST_PINS");
  loopbackOrigin(pins.bridge);
  loopbackOrigin(pins.control);
  if (pins.bridge === pins.control) throw Error("INVALID_TEST_PINS");
  return pins;
}
export function readIssuedPins(path) {
  if (typeof path !== "string") throw Error("MISSING_TEST_PINS");
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(4097);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 4096) throw Error("INVALID_TEST_PINS");
    return validatePins(JSON.parse(bytes.subarray(0, size).toString("utf8")));
  } finally {
    closeSync(fd);
  }
}
export function writeIssuedPins(path, pins) {
  const text = JSON.stringify(validatePins(pins));
  if (Buffer.byteLength(text) > 4096) throw Error("INVALID_TEST_PINS");
  writeFileSync(path + ".next", text, { mode: 0o600, flag: "wx" });
  renameSync(path + ".next", path);
}
const bridgePaths = new Set([
  "/api/internal/runtime/dispatch",
  "/api/internal/runtime/dispatch/ack",
  "/api/internal/runtime/dispatch/defer",
  "/api/internal/runtime/step",
  "/api/internal/runtime/recover",
]);
const controlPaths = new Set([
  "/seed",
  "/seed-private",
  "/state",
  "/expire-delivery",
  "/target-revoke",
  "/in-progress",
  "/pause",
  "/revoke",
  "/restore",
  "/rotate",
  "/cancel",
  "/delete",
  "/restart",
]);
async function restartReply(response) {
  const reader = response.body?.getReader();
  if (!reader) throw Error("INVALID_RESTART_REPLY");
  let text = "",
    size = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) throw Error("INVALID_RESTART_REPLY");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    void reader.cancel().catch(() => {});
  }
}
export function createTestMapper({
  bridgeOrigin,
  controlOrigin,
  readPins,
  transport = fetch,
}) {
  let active;
  return async (request) => {
    const pins = validatePins(readPins());
    if (!active) {
      if (
        loopbackOrigin(bridgeOrigin) !== pins.bridge ||
        loopbackOrigin(controlOrigin) !== pins.control
      )
        throw Error("UNISSUED_TEST_ENDPOINT");
      active = { ...pins };
    }
    if (
      pins.version !== active.version ||
      pins.bridge !== active.bridge ||
      pins.control !== active.control
    )
      throw Error("TEST_AUTHORITY_CHANGED");
    const url = new URL(request.url);
    if (
      request.url !== url.origin + url.pathname ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw Error("UNMATCHED_TEST_EGRESS");
    const bridge =
      url.origin === "https://bridge.test.invalid" &&
      request.method === "POST" &&
      bridgePaths.has(url.pathname);
    const control =
      url.origin === "https://harness.test.invalid" &&
      request.method === "GET" &&
      controlPaths.has(url.pathname);
    if (!bridge && !control) throw Error("UNMATCHED_TEST_EGRESS");
    const authorized = { ...active };
    const target =
      (bridge ? authorized.bridge : authorized.control) + url.pathname;
    const headers = new Headers(request.headers);
    headers.delete("host");
    const bytes =
      request.method === "POST" ? await request.arrayBuffer() : undefined;
    const current = validatePins(readPins());
    if (
      current.version !== authorized.version ||
      current.bridge !== authorized.bridge ||
      current.control !== authorized.control ||
      active.version !== authorized.version ||
      active.bridge !== authorized.bridge ||
      active.control !== authorized.control
    )
      throw Error("TEST_AUTHORITY_CHANGED");
    const response = await transport(target, {
      method: request.method,
      headers,
      body: bytes,
      redirect: "manual",
      signal: request.signal,
    });
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400)
    ) {
      void response.body?.cancel().catch(() => {});
      throw Error("TEST_REDIRECT_REJECTED");
    }
    if (control && url.pathname === "/restart") {
      if (
        !response.ok ||
        response.headers.has("content-encoding") ||
        response.headers.get("content-type") !== "application/json"
      ) {
        void response.body?.cancel().catch(() => {});
        throw Error("INVALID_RESTART_REPLY");
      }
      const body = await restartReply(response),
        updated = validatePins(readPins());
      if (
        !body ||
        typeof body !== "object" ||
        Object.keys(body).sort().join(",") !== "origin,version" ||
        loopbackOrigin(body.origin) !== updated.bridge ||
        body.version !== updated.version ||
        updated.version !== active.version + 1 ||
        updated.control !== active.control
      )
        throw Error("UNISSUED_RESTART_ENDPOINT");
      active = { ...updated };
      return Response.json(body);
    }
    return response;
  };
}
