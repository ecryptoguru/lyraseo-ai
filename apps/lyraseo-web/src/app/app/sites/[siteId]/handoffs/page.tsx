import "@/components/external-handoffs.css";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { database, resolveActor } from "@/server/auth/server";
import { signInDestination } from "@/server/auth/failures";
import { authSettings } from "@/server/auth/settings";
import { capabilityEnabled } from "@/server/capabilities";
import { withActor, authorizeSiteIn } from "@lyraseo/db/context";
import { listWorkspaces } from "@lyraseo/db/tenants";
import { ExternalHandoffs } from "@/components/external-handoffs";
export const dynamic = "force-dynamic";
export default async function HandoffsPage({
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
    (m) => m.id === workspaceId,
  );
  return (
    <main id="main" className="pilot-page">
      <Link
        href={`/app/sites/${encodeURIComponent(siteId)}/content?workspaceId=${encodeURIComponent(workspaceId)}`}
      >
        Back to content and reports
      </Link>
      <header className="pilot-title">
        <h1>Private external handoffs</h1>
        <p>{site.origin}</p>
      </header>
      <ExternalHandoffs
        workspaceId={workspaceId}
        siteId={siteId}
        origin={site.origin}
        manager={!!member && ["OWNER", "ADMIN"].includes(member.role)}
        editable={!!member && member.role !== "VIEWER"}
        enabled={capabilityEnabled("handoffs")}
      />
    </main>
  );
}
