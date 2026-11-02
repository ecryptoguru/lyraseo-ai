import { capabilityEnabled } from "@/server/capabilities";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { database, resolveActor } from "@/server/auth/server";
import { signInDestination } from "@/server/auth/failures";
import { authSettings } from "@/server/auth/settings";
import { withActor, authorizeSiteIn } from "@lyraseo/db/context";
import { listWorkspaces } from "@lyraseo/db/tenants";
import { AnalyticsWorkspace } from "@/components/analytics-workspace";
export const dynamic = "force-dynamic";
export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ workspaceId?: string }>;
}) {
  const { siteId } = await params,
    { workspaceId } = await searchParams;
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
  const site = await withActor(database(), actor, workspaceId, (tx) =>
    authorizeSiteIn(tx, actor, workspaceId, siteId, "read"),
  ).catch(() => null);
  if (!site) notFound();
  const member = (await listWorkspaces(database(), actor)).find(
    (entry) => entry.id === workspaceId,
  );
  return (
    <main id="main" className="pilot-page">
      <Link
        href={`/app/workspaces?workspace=${encodeURIComponent(workspaceId)}`}
      >
        Back to workspace
      </Link>
      <header className="pilot-title">
        <h1>Organic landing-page outcomes</h1>
        <p>{site.origin}</p>
      </header>
      <AnalyticsWorkspace
        collectionEnabled={capabilityEnabled("analytics")}
        workspaceId={workspaceId}
        siteId={siteId}
        manageable={member?.role === "OWNER" || member?.role === "ADMIN"}
      />
    </main>
  );
}
