import { NextResponse } from "next/server";
import { signInDestination } from "@/server/auth/failures";
import { resolveActor, database } from "@/server/auth/server";
import { listWorkspaces } from "@lyraseo/db/tenants";
import { budgetSnapshot } from "@lyraseo/db/accounting";
export async function GET() {
  try {
    const actor = await resolveActor();
    return NextResponse.json(
      {
        workspaces: await listWorkspaces(database(), actor),
        budgets: await budgetSnapshot(database(), actor),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    const unavailable = signInDestination(error) === null;
    return NextResponse.json(
      { error: unavailable ? "AUTH_UNAVAILABLE" : "UNAUTHENTICATED" },
      {
        status: unavailable ? 503 : 401,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
