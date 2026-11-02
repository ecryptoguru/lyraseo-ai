import { env } from "cloudflare:workers";
import type { Transport } from "../src/bridge";
export const ref = {
  workId: "00000000-0000-4000-8000-000000000002",
  generation: 1,
  claimToken: "00000000-0000-4000-8000-000000000003",
};
export const queued = {
  version: 1 as const,
  workId: ref.workId,
  generation: ref.generation,
};
export function enabled(): Env {
  return {
    ...env,
    CARRIER_QUALIFIED: "true",
    CARRIER_ENABLED: "true",
    BRIDGE_ORIGIN: "https://bridge.test.invalid",
    BRIDGE_KEY_ID: "test-2026",
    BRIDGE_SECRET: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    BRIDGE_PRINCIPAL: "lyraseo_dispatch",
    BRIDGE_AUDIENCE: "lyraseo-kernel-a",
  };
}
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
export function responder(
  fn: (path: string, request: Request) => Response | Promise<Response>,
): Transport {
  return (request) => {
    const url = new URL(request.url);
    if (
      url.origin !== "https://bridge.test.invalid" ||
      request.method !== "POST" ||
      url.search
    )
      throw new Error("UNMATCHED_TEST_EGRESS");
    return Promise.resolve(fn(url.pathname, request));
  };
}
