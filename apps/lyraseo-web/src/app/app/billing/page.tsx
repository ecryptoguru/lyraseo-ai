import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { database, resolveActor } from "@/server/auth/server";
import { signInDestination } from "@/server/auth/failures";
import { readSandboxBillingStatus } from "@lyraseo/db/sandbox-billing";
export const dynamic = "force-dynamic";
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ workspaceId?: string }>;
}) {
  const { workspaceId } = await searchParams;
  if (!workspaceId) notFound();
  let status: Awaited<ReturnType<typeof readSandboxBillingStatus>> | undefined;
  try {
    const actor = await resolveActor();
    if (process.env.LYRA_SANDBOX_BILLING_ENABLED === "true")
      status = await readSandboxBillingStatus(database(), actor, workspaceId);
  } catch (error) {
    const destination = signInDestination(error);
    if (destination) redirect(destination);
    notFound();
  }
  if (!status)
    return (
      <main id="main" className="pilot-page">
        <h1>Private pilot billing</h1>
        <p>
          Pilot access is free. Sandbox billing has not been enabled in this
          environment.
        </p>
      </main>
    );
  return (
    <main id="main" className="pilot-page">
      <Link
        href={`/app/workspaces?workspace=${encodeURIComponent(workspaceId)}`}
      >
        Back to workspace
      </Link>
      <h1>Private pilot billing</h1>
      <p>
        Pilot access is free. Subscription records below are sandbox evidence.
        Checkout and production paid entitlements are disabled.
      </p>
      {status.pendingIntent && (
        <p role="status">
          A sandbox subscription intent is pending canonical reconciliation.
        </p>
      )}
      {status.subscriptions.length === 0 ? (
        <p>No sandbox subscriptions are recorded.</p>
      ) : (
        <ul>
          {status.subscriptions.map((row, index) => (
            <li key={`${row.provider}-${index}`}>
              <strong>{row.provider}</strong>: {row.state}.{" "}
              {row.periodEnd
                ? `Recorded period ends ${row.periodEnd}.`
                : "Period unavailable."}{" "}
              Last reconciled {row.reconciledAt}. Production access: disabled.
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
