import type { Annotation, VisibilityProfile } from "@lyraseo/visibility";

/** Versioned format contract, independent of account/execution qualification. */
export const OBSERVATION_ADAPTER_VERSION = "observation-adapters-v1";
export type ObservationContext = Readonly<{
  profile: VisibilityProfile;
  account: string;
  taskId: string;
  prompt: string;
  promptVersion: string;
  locationCode: number;
  language: "en";
  market: "IN";
}>;
export type ObservationState =
  | "complete"
  | "no-answer"
  | "truncated"
  | "unsupported"
  | "pending"
  | "ambiguous"
  | "failed";
export type ObservationUsage = Partial<
  Record<
    | "inputTokens"
    | "outputTokens"
    | "cachedTokens"
    | "reasoningTokens"
    | "webSearchRequests"
    | "postedTasks",
    number
  >
>;
export type ObservationResult = {
  version: typeof OBSERVATION_ADAPTER_VERSION;
  profile: VisibilityProfile;
  accountFingerprint: string;
  providerLocale: { languageCode: string | null; locationCode: number | null };
  taskId: string | null;
  state: ObservationState;
  body: string | null;
  annotations: Annotation[];
  citationMapping: "known" | "unknown";
  model: string;
  modelVersion: string;
  requestedLocale: { language: "en"; market: "IN" };
  confirmedLocale: { language: string | null; market: string | null };
  usage: ObservationUsage;
  /** Exact decimal assertion only; missing/unrepresentable is unknown, never zero. */
  cost: string | null;
  costClassification: "PROVIDER_REPORTED" | "UNKNOWN";
  completedAt: string | null;
  reason: string | null;
  digest: string;
  wireDigest: string;
};
