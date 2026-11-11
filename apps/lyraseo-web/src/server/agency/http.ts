import { editorialFailure, privateHeaders } from "../editorial/http";
/** Scope and identifiers stay private while recovery instructions remain actionable. */
export function agencyFailure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "QUOTE_EXPIRED")
    return Response.json(
      {
        error:
          "This quote expired. Preview the selected scope again and review the new maximum cost before confirming.",
      },
      { status: 409, headers: privateHeaders },
    );
  if (code === "INVITATIONS_UNAVAILABLE")
    return Response.json(
      {
        error:
          "Manual invitations are unavailable. Ask the pilot operator to enable them; existing team access still works.",
      },
      { status: 503, headers: privateHeaders },
    );
  return editorialFailure(error);
}
