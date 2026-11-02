import { capabilityPause } from "@/server/capabilities";
import { database } from "@/server/auth/server";
import { authSettings } from "@/server/auth/settings";
import { tokenAccessPolicyHash } from "@lyraseo/db/tokens";
import { handleMcpRequest } from "@/server/mcp/server";
export const runtime = "nodejs";
async function handle(request: Request) {
  const paused = capabilityPause("mcp");
  if (paused) return paused;

  const settings = authSettings();
  if (!settings)
    return Response.json(
      { error: "Private pilot access unavailable." },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  return handleMcpRequest(request, {
    db: database(),
    origin: settings.origin,
    accessPolicyHash: tokenAccessPolicyHash(settings.allowedEmails),
  });
}
export { handle as POST, handle as GET, handle as DELETE };
