import type { AttemptEvidence } from "../../packages/db/src/provider-ledger";
// Illustrative amounts are deliberately synthetic. No provider SDK, fetch,
// credential, endpoint override or live qualification exists in these adapters.
export const profiles = [
  {
    profile: "azure-editorial",
    provider: "AZURE",
    kind: "GENERATION",
    steps: ["azure-response"],
    costs: ["0.031"],
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 20,
      cachedTokens: 10,
    },
  },
  {
    profile: "azure-observation",
    provider: "AZURE",
    kind: "API_OBSERVATION",
    steps: ["azure-response"],
    costs: ["0.042"],
    usage: { inputTokens: 100, outputTokens: 50, webSearchRequests: 2 },
  },
  {
    profile: "parallel-research",
    provider: "PARALLEL",
    kind: "RESEARCH",
    steps: ["search", "selected-extract-batch"],
    costs: ["0.013", "0.017"],
    usage: { searchRequests: 1, extractedUrls: 2 },
  },
  {
    profile: "chatgpt-standard",
    provider: "DATAFORSEO",
    kind: "CHATGPT_OBSERVATION",
    steps: ["consumer-post"],
    costs: ["0.012"],
    usage: { postedTasks: 1 },
  },
  {
    profile: "gemini-standard",
    provider: "DATAFORSEO",
    kind: "GEMINI_OBSERVATION",
    steps: ["consumer-post"],
    costs: ["0.012"],
    usage: { postedTasks: 1 },
  },
  {
    profile: "keyword-batch",
    provider: "DATAFORSEO",
    kind: "KEYWORD_ENRICHMENT",
    steps: ["keyword-batch"],
    costs: ["0.019"],
    usage: { postedTasks: 1 },
  },
] as const;
export function fixtureAnswer(
  profile: (typeof profiles)[number],
  step: number,
  observedAt: string,
): AttemptEvidence {
  return {
    kind: "RESOLVED",
    accepted: true,
    outputValid: true,
    cost: profile.costs[step],
    costVersion: 1,
    observedAt,
    usage: profile.usage,
  };
}
