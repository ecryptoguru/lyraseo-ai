import { capabilityEnabled } from "@/server/capabilities";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { database, resolveActor } from "@/server/auth/server";
import { signInDestination } from "@/server/auth/failures";
import { authSettings } from "@/server/auth/settings";
import { withActor, authorizeSiteIn } from "@lyraseo/db/context";
import { listWorkspaces } from "@lyraseo/db/tenants";
import { SiteSettings } from "@/components/site-settings";
import { readSiteContextRevisions, type SiteContext } from "@lyraseo/db/sites";

export const dynamic = "force-dynamic";
export default async function SiteSettingsPage({
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
  const membership = (await listWorkspaces(database(), actor)).find(
    (entry) => entry.id === workspaceId,
  );
  const settings = authSettings();
  const enabled =
    process.env.LYRA_LOCAL_RAW_AUDITS === "true" &&
    process.env.VERCEL !== "1" &&
    !!settings &&
    ["localhost", "127.0.0.1"].includes(new URL(settings.origin).hostname);
  return (
    <main id="main" className="pilot-page">
      <Link
        href={`/app/workspaces?workspace=${encodeURIComponent(workspaceId)}`}
      >
        Back to workspace
      </Link>
      <header className="pilot-title">
        <h1>{site.origin}</h1>
        <p>Verify ownership and maintain reviewed facts for your site.</p>
      </header>
      <SiteSettings
        contextEnabled={capabilityEnabled("context")}
        proofEnabled={capabilityEnabled("audits")}
        workspaceId={workspaceId}
        siteId={siteId}
        editable={!!membership && membership.role !== "VIEWER"}
        manager={!!membership && ["OWNER", "ADMIN"].includes(membership.role)}
        initialRevisions={(
          await readSiteContextRevisions(database(), actor, {
            workspaceId,
            siteId,
          })
        ).map((r) => ({
          ...r,
          content: r.content as unknown as SiteContext,
          reviewedAt: r.reviewedAt.toISOString(),
        }))}
        verifiedAt={site.verifiedAt?.toISOString() ?? null}
        enabled={enabled}
      />
    </main>
  );
}
