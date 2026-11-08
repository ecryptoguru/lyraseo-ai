import { describe, expect, it } from "vitest";
import {
  normalizeAzure,
  normalizeConsumer,
} from "../../apps/lyraseo-web/src/server/providers/observations/normalizers";
import {
  observationCapabilities,
  buildObservationRequest,
} from "../../apps/lyraseo-web/src/server/providers/observations/requests";

const context = {
  profile: "azure-sol-api" as const,
  account: "fixture-account",
  taskId: "response-1",
  prompt: "Which tools?",
  promptVersion: "frozen-v1",
  locationCode: 2356,
  language: "en" as const,
  market: "IN" as const,
};
const azure = () => ({
  id: "response-1",
  model: "fixture-sol-returned",
  status: "completed",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "Alpha and Beta",
          annotations: [
            {
              type: "url_citation",
              url: "https://alpha.example/",
              start_index: 0,
              end_index: 5,
            },
          ],
        },
      ],
    },
  ],
  usage: {
    input_tokens: 20,
    output_tokens: 10,
    output_tokens_details: { reasoning_tokens: 4 },
  },
  tool_usage: { web_search: { num_requests: 2 } },
});
const consumer = (engine = "chat_gpt") => ({
  version: "fixture-schema-v1",
  status_code: 20000,
  tasks_count: 1,
  tasks: [
    {
      id: "task-1",
      status_code: 20000,
      cost: 0,
      path: [
        "v3",
        "ai_optimization",
        engine,
        "llm_scraper",
        "task_get",
        "advanced",
        "task-1",
      ],
      data: {
        api: "ai_optimization",
        function: "llm_scraper",
        se: engine,
        keyword: "Which tools?",
        language_code: "en",
        location_code: 2356,
      },
      result_count: 1,
      result: [
        {
          keyword: "Which tools?",
          language_code: "en",
          location_code: 2356,
          model: engine === "gemini" ? "Fast" : "provider-label",
          datetime: "2026-11-02 12:00:00 +00:00",
          markdown: "Alpha and [Beta](https://beta.example/)",
          sources: [{ url: "https://source-only.example/" }],
        },
      ],
    },
  ],
});
const consumerContext = {
  ...context,
  profile: "consumer-chatgpt" as const,
  taskId: "task-1",
};

describe("bounded observation normalization", () => {
  it("retains returned model, actual usage and only in-answer citation spans", () => {
    const result = normalizeAzure(JSON.stringify(azure()), context);
    expect(result.state).toBe("complete");
    expect(result.model).toBe("fixture-sol-returned");
    expect(result.usage).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      reasoningTokens: 4,
      webSearchRequests: 2,
    });
    expect(result.annotations).toEqual([
      { url: "https://alpha.example/", start: 0, end: 5 },
    ]);
    expect(result.confirmedLocale).toEqual({ language: null, market: null });
    expect(result.cost).toBeNull();
  });
  it("has a stable semantic digest across field ordering but retains a distinct wire digest", () => {
    const wire = azure();
    const a = normalizeAzure(JSON.stringify(wire), context);
    const b = normalizeAzure(
      JSON.stringify(Object.fromEntries(Object.entries(wire).reverse())),
      context,
    );
    expect(b.digest).toBe(a.digest);
    expect(b.wireDigest).not.toBe(a.wireDigest);
    wire.output[0]!.content[0]!.text = "Other and Beta";
    expect(normalizeAzure(JSON.stringify(wire), context).digest).not.toBe(
      a.digest,
    );
  });
  it.each(["incomplete", "failed", "in_progress", "queued", "mystery"])(
    "does not count Azure %s as measured absence",
    (status) => {
      const result = normalizeAzure(
        JSON.stringify({ ...azure(), status }),
        context,
      );
      expect(result.state).not.toBe("complete");
    },
  );
  it("preserves refusal and withholds schema-drifted output", () => {
    const wire = azure();
    wire.output[0]!.content = [
      { type: "refusal", refusal: "I cannot assist" },
    ] as never;
    expect(normalizeAzure(JSON.stringify(wire), context).state).toBe(
      "no-answer",
    );
    wire.output[0]!.content = [
      { type: "new_text_type", text: "Alpha" },
    ] as never;
    expect(normalizeAzure(JSON.stringify(wire), context).state).toBe(
      "unsupported",
    );
  });
  it.each(["consumer-chatgpt", "consumer-gemini"] as const)(
    "keeps %s separate and never promotes source arrays to citations",
    (profile) => {
      const wire = consumer(
        profile === "consumer-gemini" ? "gemini" : "chat_gpt",
      );
      const result = normalizeConsumer(JSON.stringify(wire), {
        ...consumerContext,
        profile,
      });
      expect(result.state).toBe("complete");
      expect(result.body).toBe("Alpha and Beta");
      expect(result.annotations).toEqual([
        { url: "https://beta.example/", start: 10, end: 14 },
      ]);
      expect(result.confirmedLocale).toEqual({ language: "en", market: null });
      expect(result.providerLocale).toEqual({
        languageCode: "en",
        locationCode: 2356,
      });
      expect(result.model).toBe(
        profile === "consumer-gemini" ? "Fast" : "provider-label",
      );
    },
  );
  it("retains exact charge lexemes without floating point rounding or rounding excess precision down", () => {
    const wire = JSON.stringify(consumer()).replace(
      '"cost":0',
      '"cost":0.001200001',
    );
    expect(normalizeConsumer(wire, consumerContext).cost).toBe("0.001200001");
    expect(
      normalizeConsumer(
        wire.replace("0.001200001", "0.0012000011"),
        consumerContext,
      ).cost,
    ).toBeNull();
  });
  it.each([
    '{"decimal":"0.0012"}',
    '[{"decimal":"0.0012"}]',
    '{"exactDecimal":"0.0012"}',
  ])("never trusts provider-supplied %s as a numeric cost token", (value) => {
    const wire = JSON.stringify(consumer()).replace(
      '"cost":0',
      `"cost":${value}`,
    );
    expect(normalizeConsumer(wire, consumerContext)).toMatchObject({
      state: "complete",
      cost: null,
      costClassification: "UNKNOWN",
    });
  });
  it("withholds duplicate-key results and their costs instead of taking the last member", () => {
    const base = JSON.stringify(consumer()).replace(
      '"cost":0',
      '"cost":0.0012',
    );
    const variants = [
      base.replace('"cost":0.0012', '"cost":3,"cost":0.0012'),
      base.replace('"markdown":', '"markdown":"Other answer","markdown":'),
      base.replace(
        '"status_code":20000',
        '"status_code":50000,"status_code":20000',
      ),
    ];
    for (const wire of variants)
      expect(normalizeConsumer(wire, consumerContext)).toMatchObject({
        state: "unsupported",
        body: null,
        cost: null,
        costClassification: "UNKNOWN",
      });
    const azureWire = JSON.stringify(azure()).replace(
      '"status":"completed"',
      '"status":"failed","status":"completed"',
    );
    expect(normalizeAzure(azureWire, context)).toMatchObject({
      state: "unsupported",
      body: null,
    });
  });
  it.each([
    (w: ReturnType<typeof consumer>) => {
      w.tasks[0]!.id = "wrong";
    },
    (w: ReturnType<typeof consumer>) => {
      w.tasks[0]!.data.se = "gemini";
    },
    (w: ReturnType<typeof consumer>) => {
      w.tasks[0]!.result[0]!.language_code = "fr";
    },
    (w: ReturnType<typeof consumer>) => {
      w.tasks[0]!.data.keyword = "Changed";
    },
    (w: ReturnType<typeof consumer>) => {
      w.tasks.push(w.tasks[0]!);
    },
  ])(
    "rejects mismatched frozen task/profile/locale/prompt and multi-task drift",
    (change) => {
      const wire = consumer();
      change(wire);
      expect(
        normalizeConsumer(JSON.stringify(wire), consumerContext).state,
      ).toBe("unsupported");
    },
  );
  it("does not invent usage or zero cost and bounds malformed/oversized envelopes", () => {
    const wire = azure();
    delete (wire as Partial<typeof wire>).usage;
    expect(normalizeAzure(JSON.stringify(wire), context).usage).toEqual({
      webSearchRequests: 2,
    });
    expect(normalizeAzure("{bad", context).state).toBe("unsupported");
    expect(normalizeAzure("x".repeat(524289), context).state).toBe(
      "unsupported",
    );
  });
  it("keeps a complete no-mention answer eligible independently of brand matching", () => {
    const wire = azure();
    wire.output[0]!.content[0]!.text = "No branded option is included.";
    wire.output[0]!.content[0]!.annotations = [];
    expect(normalizeAzure(JSON.stringify(wire), context).state).toBe(
      "complete",
    );
  });
});
it("returns per-profile account/rights/tariff/market unavailability before building any live request", () => {
  for (const capability of observationCapabilities()) {
    expect(capability.available).toBe(false);
    expect(capability.reasons.length).toBeGreaterThan(0);
    expect(
      buildObservationRequest({ ...context, profile: capability.profile }, {
        status: "QUALIFIED",
        enabled: true,
      } as never),
    ).toMatchObject({ available: false });
  }
});
it("extracts each configured brand from one body while excluding provider-only source mentions", async () => {
  const { extractBrands } =
    await import("../../packages/visibility/src/measurement");
  const wire = consumer();
  wire.tasks[0]!.result[0]!.markdown = "Alpha and Beta";
  wire.tasks[0]!.result[0]!.sources = [{ url: "https://source-only.example/" }];
  const result = normalizeConsumer(JSON.stringify(wire), consumerContext);
  const extraction = extractBrands(result.body!, result.annotations, [
    { id: "a", name: "Alpha", aliases: ["Alpha"], domains: ["alpha.example"] },
    { id: "b", name: "Beta", aliases: ["Beta"], domains: ["beta.example"] },
    {
      id: "s",
      name: "Source only",
      aliases: ["source-only"],
      domains: ["source-only.example"],
    },
  ]);
  expect(extraction.a?.mention).toBe(true);
  expect(extraction.b?.mention).toBe(true);
  expect(extraction.s?.mention).toBe(false);
  expect(extraction.s?.citation).toBe(false);
});
it("does not infer a country from a matching provider location code without account-specific locale qualification", () => {
  const result = normalizeConsumer(JSON.stringify(consumer()), consumerContext);
  expect(result.requestedLocale.market).toBe("IN");
  expect(result.providerLocale.locationCode).toBe(2356);
  expect(result.confirmedLocale.market).toBeNull();
});
it.each([
  { account: "x".repeat(129) },
  { taskId: "x".repeat(257) },
  { promptVersion: "x".repeat(129) },
  { locationCode: -1 },
])(
  "rejects unbounded or invalid frozen identity before envelope interpretation",
  (change) => {
    expect(() =>
      normalizeAzure(JSON.stringify(azure()), { ...context, ...change }),
    ).toThrow("INVALID_OBSERVATION_CONTEXT");
  },
);
it("does not promote an incomplete assistant message inside a completed Azure envelope", () => {
  const wire = azure();
  Object.assign(wire.output[0]!, { status: "incomplete" });
  expect(normalizeAzure(JSON.stringify(wire), context).state).toBe("truncated");
});
it("withholds citation mapping when an unqualified Unicode index convention could shift spans", () => {
  const wire = azure();
  wire.output[0]!.content[0]!.text = "😀 Alpha";
  wire.output[0]!.content[0]!.annotations = [
    {
      type: "url_citation",
      url: "https://alpha.example/",
      start_index: 2,
      end_index: 7,
    },
  ];
  const result = normalizeAzure(JSON.stringify(wire), context);
  expect(result.state).toBe("complete");
  expect(result.citationMapping).toBe("unknown");
  expect(result.annotations).toEqual([]);
});
