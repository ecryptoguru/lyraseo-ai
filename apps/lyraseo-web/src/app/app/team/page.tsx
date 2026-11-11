import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { database, resolveActor } from "@/server/auth/server";
import { signInDestination } from "@/server/auth/failures";
import { authSettings } from "@/server/auth/settings";
import { listWorkspaceMembers } from "@lyraseo/db/tenants";
import { readWorkspaceBranding } from "@lyraseo/db/branding";
import { BrandingSettings } from "@/components/branding-settings";
import { TeamSettings } from "@/components/team-settings";
export const dynamic = "force-dynamic";
export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ workspaceId?: string }>;
}) {
  const { workspaceId } = await searchParams;
  if (!workspaceId) notFound();
  if (!authSettings()) redirect("/sign-in");
  const actor = await resolveActor().catch((error) => {
    const destination = signInDestination(error);
    if (destination) redirect(destination);
    throw error;
  });
  const team = await listWorkspaceMembers(database(), actor, workspaceId).catch(
    () => null,
  );
  if (!team) notFound();
  const branding = await readWorkspaceBranding(database(), actor, workspaceId);
  return (
    <main id="main" className="pilot-page">
      <Link
        href={`/app/workspaces?workspace=${encodeURIComponent(workspaceId)}`}
      >
        Back to workspace
      </Link>
      <header className="pilot-title">
        <h1>Workspace access</h1>
      </header>
      <TeamSettings
        workspaceId={workspaceId}
        initial={team}
        callerId={actor.userId}
      />
      <BrandingSettings
        workspaceId={workspaceId}
        initial={branding}
        siteId={team.sites[0]?.id}
      />
    </main>
  );
}
