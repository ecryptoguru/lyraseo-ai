import { googleFailure, googleHeaders } from "./http";
export function analyticsFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const safe = [
    "ANALYTICS_UNAVAILABLE",
    "ANALYTICS_DISCONNECTED",
    "ANALYTICS_RECONNECT_REQUIRED",
    "ANALYTICS_SCOPE_ERROR",
    "ANALYTICS_SELECTION_REQUIRED",
    "ANALYTICS_CONSENT_DENIED",
    "ANALYTICS_CONNECTION_CHANGED",
    "ANALYTICS_TEMPORARILY_UNAVAILABLE",
    "ANALYTICS_IMPORT_RUNNING",
    "ANALYTICS_IMPORT_CHANGED",
    "ANALYTICS_IMPORT_FAILED",
    "ANALYTICS_CATALOG_LIMIT",
    "ANALYTICS_RESPONSE_LIMIT",
    "ANALYTICS_REQUEST_LIMIT",
    "ANALYTICS_INCOMPATIBLE_REPORT",
    "EXACT_VERIFIED_ORIGIN_REQUIRED",
    "INVALID_OAUTH_STATE",
    "INVALID_SEARCH_WINDOW",
    "INVALID_ANALYTICS_RESPONSE",
  ];
  if (!safe.includes(message)) return googleFailure(error);
  return Response.json(
    { error: message },
    {
      status: message === "ANALYTICS_UNAVAILABLE" ? 503 : 409,
      headers: googleHeaders,
    },
  );
}
