import { NextResponse } from "next/server";
import { resolveActor, database } from "@/server/auth/server";
import { signInDestination } from "@/server/auth/failures";
import { readOperation } from "@lyraseo/db/execution";

/** Polling reads persisted state and never dispatches work. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ operationId: string }> },
) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const actor = await resolveActor();
    const { operationId } = await context.params;
    if (!operationId || operationId.length > 128)
      return NextResponse.json(
        { error: "INVALID_REQUEST" },
        { status: 400, headers },
      );
    return NextResponse.json(
      await readOperation(database(), actor, operationId),
      { headers },
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (["NOT_FOUND", "FORBIDDEN"].includes(code))
      return NextResponse.json(
        { error: "NOT_FOUND" },
        { status: 404, headers },
      );
    if (signInDestination(error))
      return NextResponse.json(
        { error: "UNAUTHENTICATED" },
        { status: 401, headers },
      );
    return NextResponse.json(
      { error: "SERVICE_UNAVAILABLE" },
      { status: 503, headers },
    );
  }
}
