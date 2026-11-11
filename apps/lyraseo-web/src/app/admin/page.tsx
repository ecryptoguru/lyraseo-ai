import { notFound, redirect } from "next/navigation";
import { readStaffView, type SupportView } from "@lyraseo/db/sandbox-billing";
import { requireStaffFor, staffDatabase } from "@/server/admin/staff";
import { signInDestination } from "@/server/auth/failures";
import { StaffConsole } from "@/components/staff-console";
export const dynamic = "force-dynamic";
export default async function AdminPage() {
  let controls: SupportView | undefined,
    unavailable = false;
  try {
    const actor = await requireStaffFor("read");
    controls = await readStaffView(staffDatabase(), actor, "controls");
  } catch (error) {
    const destination = signInDestination(error);
    if (destination) redirect(destination);
    if (error instanceof Error && error.message === "STAFF_UNAVAILABLE")
      unavailable = true;
    else notFound();
  }
  if (unavailable)
    return (
      <main id="main" className="pilot-page">
        <h1>Staff tools unavailable</h1>
        <p>The restricted staff database connection has not been configured.</p>
      </main>
    );
  if (!controls) notFound();
  return (
    <main id="main" className="pilot-page">
      <header className="pilot-title">
        <p>Private staff administration</p>
        <h1>Pilot operations</h1>
        <p>
          Sandbox billing and recovery rehearsal. Pilot access stays free.
          Production commerce is disabled.
        </p>
      </header>
      <StaffConsole initial={controls} />
    </main>
  );
}
