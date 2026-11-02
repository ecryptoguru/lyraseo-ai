/** Trusted server configuration only. Never derive rollout from a request. */
export const capabilities = [
  "audits",
  "context",
  "search",
  "analytics",
  "content",
  "visibility",
  "mcp",
] as const;
export type Capability = (typeof capabilities)[number];
export function capabilityEnabled(capability: Capability): boolean {
  return (process.env.LYRA_ENABLED_CAPABILITIES ?? "")
    .split(",")
    .map((name) => name.trim())
    .includes(capability);
}
export function capabilityPause(capability: Capability): Response | undefined {
  if (!capabilityEnabled(capability))
    return Response.json(
      { error: "CAPABILITY_PAUSED", capability },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
}
