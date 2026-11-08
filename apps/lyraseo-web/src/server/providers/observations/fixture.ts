import { createHash } from "node:crypto";
import type { VisibilityProfile } from "@lyraseo/visibility";
import type { ObservationContext } from "./contracts";
import { consumerStandardRequest } from "./consumer-standard";

export type ObservationFixtureScenario =
  | "complete"
  | "refusal"
  | "truncated"
  | "wrong-locale"
  | "missing-cost"
  | "pending"
  | "ambiguous-post";
export type ObservationFixture = Readonly<{
  source: "SYNTHETIC";
  version: "observation-fixture-v1";
  profile: VisibilityProfile;
}>;
type Fixture = { scenario: ObservationFixtureScenario; submitted: Set<string> };
const fixtures = new WeakMap<ObservationFixture, Fixture>();
/** Only this synthetic catalog can enter offline orchestration. No wire bytes,
 * endpoints, credentials or arbitrary executor callbacks can be supplied. */
export function createObservationFixture(
  profile: VisibilityProfile,
  scenario: ObservationFixtureScenario,
): ObservationFixture {
  if (
    !["azure-sol-api", "consumer-chatgpt", "consumer-gemini"].includes(
      profile,
    ) ||
    ![
      "complete",
      "refusal",
      "truncated",
      "wrong-locale",
      "missing-cost",
      "pending",
      "ambiguous-post",
    ].includes(scenario)
  )
    throw Error("UNSUPPORTED_FIXTURE");
  const value = Object.freeze({
    source: "SYNTHETIC" as const,
    version: "observation-fixture-v1" as const,
    profile,
  });
  fixtures.set(value, { scenario, submitted: new Set() });
  return value;
}
export function checkedObservationFixture(value: ObservationFixture) {
  const fixture = fixtures.get(value);
  if (!fixture) throw Error("UNTRUSTED_OBSERVATION_FIXTURE");
  return Object.freeze({ scenario: fixture.scenario });
}
export function fixtureRequest(
  fixture: ObservationFixture,
  prompt: string,
  promptVersion: string,
  correlation: string,
) {
  checkedObservationFixture(fixture);
  if (
    !prompt.trim() ||
    prompt.length > 4000 ||
    !promptVersion ||
    promptVersion.length > 128 ||
    !/^[a-zA-Z0-9._:-]{1,128}$/.test(correlation)
  )
    throw Error("INVALID_FROZEN_REQUEST");
  const hash = createHash("sha256").update(correlation).digest("hex");
  const taskId =
    fixture.profile === "azure-sol-api"
      ? `synthetic-${hash.slice(0, 24)}`
      : `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  const context: ObservationContext = {
    profile: fixture.profile,
    account: `synthetic-fixture-account:${fixture.profile === "azure-sol-api" ? "AZURE" : "DATAFORSEO"}`,
    taskId,
    prompt,
    promptVersion,
    locationCode: 2356,
    language: "en",
    market: "IN",
  };
  // These are format examples only: 2356 is fixture metadata, not qualified India support.
  const request =
    fixture.profile === "azure-sol-api"
      ? {
          method: "POST",
          path: "/openai/v1/responses",
          body: {
            model: "synthetic-sol-deployment",
            input: prompt,
            store: false,
            stream: false,
            max_output_tokens: 512,
            reasoning: { effort: "medium" },
            tools: [
              {
                type: "web_search",
                user_location: { type: "approximate", country: "IN" },
              },
            ],
          },
        }
      : {
          method: "POST",
          ...consumerStandardRequest({
            profile: fixture.profile,
            prompt,
            correlation,
            language: "en",
            locationCode: 2356,
          }),
        };
  return { request, context };
}
export function submitFixture(
  fixture: ObservationFixture,
  context: ObservationContext,
  attemptId: string,
  correlation: string,
) {
  checkedObservationFixture(fixture);
  const data = fixtures.get(fixture)!;
  if (data.submitted.has(attemptId)) throw Error("FIXTURE_ALREADY_SUBMITTED");
  data.submitted.add(attemptId);
  if (data.scenario === "ambiguous-post") throw Error("SYNTHETIC_POST_TIMEOUT");
  if (fixture.profile === "azure-sol-api")
    return {
      kind: "azure" as const,
      taskId: context.taskId,
      cost: data.scenario === "missing-cost" ? null : "0.0001",
    };
  const engine = fixture.profile === "consumer-chatgpt" ? "chat_gpt" : "gemini";
  return {
    kind: "consumer" as const,
    wire: JSON.stringify({
      status_code: 20000,
      tasks_count: 1,
      tasks_error: 0,
      tasks: [
        {
          id: context.taskId,
          status_code: 20100,
          ...(data.scenario === "missing-cost" ? {} : { cost: 0.0012 }),
          result_count: 0,
          result: null,
          path: ["v3", "ai_optimization", engine, "llm_scraper", "task_post"],
          data: {
            se: engine,
            keyword: context.prompt,
            language_code: context.language,
            location_code: context.locationCode,
            tag: correlation,
          },
        },
      ],
    }),
  };
}
export function fixtureResponse(
  fixture: ObservationFixture,
  context: ObservationContext,
) {
  const { scenario } = checkedObservationFixture(fixture);
  const body =
    scenario === "refusal"
      ? "I cannot assist with this request."
      : "Alpha and Beta are options.";
  if (fixture.profile === "azure-sol-api")
    return JSON.stringify({
      id: context.taskId,
      model: "synthetic-sol-v1",
      status:
        scenario === "truncated"
          ? "incomplete"
          : scenario === "pending"
            ? "in_progress"
            : "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            scenario === "refusal"
              ? { type: "refusal", refusal: body }
              : { type: "output_text", text: body, annotations: [] },
          ],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 6 },
      tool_usage: { web_search: { num_requests: 1 } },
    });
  const engine = fixture.profile === "consumer-chatgpt" ? "chat_gpt" : "gemini";
  return JSON.stringify({
    version: "synthetic-schema-v1",
    status_code: 20000,
    tasks_count: 1,
    tasks: [
      {
        id: context.taskId,
        status_code: scenario === "pending" ? 40602 : 20000,
        cost: 0,
        path: [
          "v3",
          "ai_optimization",
          engine,
          "llm_scraper",
          "task_get",
          "advanced",
          context.taskId,
        ],
        data: {
          api: "ai_optimization",
          function: "llm_scraper",
          se: engine,
          keyword: context.prompt,
          language_code: "en",
          location_code: context.locationCode,
        },
        result_count: 1,
        result: [
          {
            keyword: context.prompt,
            language_code: scenario === "wrong-locale" ? "fr" : "en",
            location_code: context.locationCode,
            model:
              fixture.profile === "consumer-gemini"
                ? "synthetic-Fast"
                : "synthetic-ChatGPT",
            datetime: "2026-11-02 12:00:00 +00:00",
            markdown: scenario === "truncated" ? null : body,
            sources: [],
          },
        ],
      },
    ],
  });
}
