import { capabilityEnabled } from "@/server/capabilities";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { database, resolveActor } from "@/server/auth/server";
import { signInDestination } from "@/server/auth/failures";
import { authSettings } from "@/server/auth/settings";
import { listWorkspaces, listSites } from "@lyraseo/db/tenants";
import { ApiAccess } from "@/components/api-access";
export const dynamic = "force-dynamic";
export default async function AccessPage({
  searchParams,
}: {
  searchParams: Promise<{ workspaceId?: string }>;
}) {
  const { workspaceId } = await searchParams;
  if (!workspaceId) notFound();
  let actor;
  try {
    actor = await resolveActor();
  } catch (error) {
    const destination = signInDestination(error);
    if (destination) redirect(destination);
    if (!authSettings()) redirect("/sign-in");
    throw error;
  }
  const workspace = (await listWorkspaces(database(), actor)).find(
    (entry) => entry.id === workspaceId,
  );
  if (!workspace) notFound();
  const sites = await listSites(database(), actor, workspaceId);
  return (
    <main id="main" className="pilot-page">
      <Link
        href={`/app/workspaces?workspace=${encodeURIComponent(workspaceId)}`}
      >
        Back to workspace
      </Link>
      <header className="pilot-title">
        <h1>API and MCP credentials</h1>
        <p>{workspace.name}</p>
      </header>
      <ApiAccess
        collectionEnabled={capabilityEnabled("mcp")}
        workspaceId={workspaceId}
        sites={sites.map((site) => ({ id: site.id, origin: site.origin }))}
      />
    </main>
  );
}
