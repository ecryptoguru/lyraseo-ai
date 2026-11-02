export const dynamic = "force-dynamic";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signInDestination } from "@/server/auth/failures";
import { authSettings } from "@/server/auth/settings";
import { resolveActor, database } from "@/server/auth/server";
import { listWorkspaces, listSites } from "@lyraseo/db/tenants";
import { budgetSnapshot } from "@lyraseo/db/accounting";
import { signOut } from "@/app/sign-in/actions";
export default async function Workspaces({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>;
}) {
  let actor;
  if (!authSettings()) redirect("/sign-in");
  try {
    actor = await resolveActor();
  } catch (error) {
    const destination = signInDestination(error);
    if (destination) redirect(destination);
    throw error;
  }
  const workspaces = await listWorkspaces(database(), actor),
    query = await searchParams;
  const selected =
    workspaces.find((w) => w.id === query.workspace) ?? workspaces[0];
  const sites = selected ? await listSites(database(), actor, selected.id) : [];
  const budgets = await budgetSnapshot(database(), actor);
  return (
    <main id="main" className="pilot-page">
      <header className="pilot-header">
        <Link href="/">
          <img
            className="logo-on-light"
            src="/brand/logo-light.svg"
            alt="LyraSEO AI"
            width="210"
            height="42"
          />
          <img
            className="logo-on-dark"
            src="/brand/logo-dark.svg"
            alt="LyraSEO AI"
            width="210"
            height="42"
          />
        </Link>
        <span className="badge">Private pilot</span>
        <Link href="/app/security">Account security</Link>
        <form action={signOut}>
          <button className="button button-secondary">Sign out</button>
        </form>
      </header>
      <div className="pilot-title">
        <p className="eyebrow">YOUR WORKSPACE</p>
        <h1>A clear view of what’s next.</h1>
        <p>Manage your sites and review your testing allowance.</p>
      </div>
      <section className="pilot-card" aria-labelledby="workspace-heading">
        <h2 id="workspace-heading">Workspaces</h2>
        {workspaces.length ? (
          <nav aria-label="Choose workspace" className="pilot-tabs">
            {workspaces.map((w) => (
              <Link
                className="button button-secondary"
                aria-current={w.id === selected?.id ? "page" : undefined}
                key={w.id}
                href={`?workspace=${encodeURIComponent(w.id)}`}
              >
                {w.name} · {w.role.toLowerCase()}
              </Link>
            ))}
          </nav>
        ) : (
          <p>
            Your account is ready. The pilot operator will assign your
            workspace; no sample customer data has been added.
          </p>
        )}
        {selected && (
          <>
            <h3>Sites in {selected.name}</h3>
            {sites.length ? (
              <ul className="pilot-sites">
                {sites.map((s) => (
                  <li key={s.id}>
                    <strong>{s.origin}</strong>
                    <span>
                      {s.verifiedAt
                        ? "Ownership evidence recorded"
                        : "Ownership verification needed"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No sites are assigned to you in this workspace.</p>
            )}
          </>
        )}
      </section>
      <section className="pilot-card" aria-labelledby="budget-heading">
        <h2 id="budget-heading">This month’s testing allowance</h2>
        <p>
          Per account, across all workspaces. UTC calendar month; unused
          allowance does not roll over.
        </p>
        <div className="pilot-budgets">
          {budgets
            .filter((b) =>
              ["COMBINED", "AZURE", "PARALLEL", "DATAFORSEO"].includes(
                b.bucket,
              ),
            )
            .map((b) => (
              <div key={b.bucket}>
                <p>
                  {
                    (
                      {
                        COMBINED: "Total",
                        AZURE: "Azure AI",
                        PARALLEL: "Parallel",
                        DATAFORSEO: "DataForSEO",
                      } as Record<string, string>
                    )[b.bucket]
                  }
                </p>
                <strong>
                  ${b.spent.plus(b.reserved).toFixed(2)}{" "}
                  <small>/ ${b.limit.toFixed(2)}</small>
                </strong>
                <p>
                  ${b.spent.toFixed(2)} used · ${b.reserved.toFixed(2)}{" "}
                  committed
                </p>
              </div>
            ))}
        </div>
        <p className="notice">
          Provider execution is not connected yet. No paid job can be started
          from this screen.
        </p>
      </section>
    </main>
  );
}
