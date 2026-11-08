import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { database, resolveActor } from "@/server/auth/server";
import { signInDestination } from "@/server/auth/failures";
import { authSettings } from "@/server/auth/settings";
import { listWorkspaces } from "@lyraseo/db/tenants";
import { AgencyBatches } from "@/components/agency-batches";
import { listAgencyPortfolio } from "@lyraseo/db/agency";
export const dynamic = "force-dynamic";
export default async function AgencyPage({
  searchParams,
}: {
  searchParams: Promise<{ workspaceId?: string; cursor?: string }>;
}) {
  const { workspaceId, cursor } = await searchParams;
  if (!workspaceId) notFound();
  if (!authSettings()) redirect("/sign-in");
  const actor = await resolveActor().catch((error) => {
    const destination = signInDestination(error);
    if (destination) redirect(destination);
    throw error;
  });
  const portfolio = await listAgencyPortfolio(database(), actor, workspaceId, {
    cursor,
  }).catch(() => null);
  if (!portfolio) notFound();
  const client = portfolio.role === "VIEWER";
  const workspaces = await listWorkspaces(database(), actor);
  return (
    <main id="main" className="pilot-page">
      <Link
        href={`/app/workspaces?workspace=${encodeURIComponent(workspaceId)}`}
      >
        Choose workspace
      </Link>
      <nav className="pilot-tabs" aria-label="Choose workspace">
        {workspaces.map((workspace) => (
          <Link
            key={workspace.id}
            aria-current={workspace.id === workspaceId ? "page" : undefined}
            href={`/app/workspaces?workspace=${encodeURIComponent(workspace.id)}`}
          >
            {workspace.name}
          </Link>
        ))}
      </nav>
      <header className="pilot-title">
        <p className="eyebrow">PRIVATE PILOT</p>
        <h1>{client ? "Your saved site evidence" : "Agency portfolio"}</h1>
        <p>
          {client
            ? "Read saved audits and private reports for the sites granted to you."
            : "Review saved evidence and page assignments across your authorized sites."}{" "}
          Each measurement retains its own source and coverage.
        </p>
      </header>
      {!portfolio.sites.length && (
        <section className="pilot-card">
          <h2>No granted sites</h2>
          <p>
            Your workspace manager can grant site access. Saved evidence appears
            here after access is granted.
          </p>
        </section>
      )}
      {portfolio.sites.map((site) => (
        <section
          className="pilot-card"
          key={site.id}
          aria-labelledby={`site-${site.id}`}
        >
          <h2 id={`site-${site.id}`}>{site.origin}</h2>
          <p>
            {site.verifiedAt
              ? "Ownership evidence recorded"
              : "Ownership verification needed"}
          </p>
          {site.latestAudit ? (
            <>
              <p>
                Latest saved audit: {site.latestAudit.status.toLowerCase()} ·{" "}
                {site.latestAudit.createdAt.toISOString().slice(0, 10)}
              </p>
              <p>
                Method {site.latestAudit.methodologyVersion} ·{" "}
                {site.latestAudit.profile}.{" "}
                {site.latestAudit.coverage
                  ? `Coverage: ${JSON.stringify(site.latestAudit.coverage)}`
                  : "Coverage unavailable for this run."}
              </p>
            </>
          ) : (
            <p>No retained saved audit yet.</p>
          )}
          <p>
            {site.reports.count} saved reports
            {site.reports.latestAt
              ? ` · latest ${site.reports.latestAt.toISOString().slice(0, 10)}`
              : ""}
            .
          </p>
          {!client && (
            <p>
              {site.tasks.assigned} assigned pages · {site.tasks.unassigned}{" "}
              unassigned pages.
            </p>
          )}
          <nav
            className="pilot-tabs"
            aria-label={`Saved evidence for ${site.origin}`}
          >
            <Link
              href={`/app/sites/${encodeURIComponent(site.id)}/audits?workspaceId=${encodeURIComponent(workspaceId)}`}
            >
              Saved audits
            </Link>
            <Link
              href={`/app/sites/${encodeURIComponent(site.id)}/content?workspaceId=${encodeURIComponent(workspaceId)}`}
            >
              Private reports
            </Link>
            {!client && (
              <Link
                href={`/app/sites/${encodeURIComponent(site.id)}/pages?workspaceId=${encodeURIComponent(workspaceId)}`}
              >
                Page workspaces
              </Link>
            )}
          </nav>
          <p>
            Partial, unreadable or missing evidence does not prove a fix. These
            are saved results; opening this page makes no provider request.
          </p>
        </section>
      ))}
      {!client && (
        <AgencyBatches workspaceId={workspaceId} sites={portfolio.sites} />
      )}
      {portfolio.nextCursor && (
        <Link
          className="button button-secondary"
          href={`?workspaceId=${encodeURIComponent(workspaceId)}&cursor=${encodeURIComponent(portfolio.nextCursor)}`}
        >
          Next sites
        </Link>
      )}
    </main>
  );
}
