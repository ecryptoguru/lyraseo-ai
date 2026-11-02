import { expect, it } from "vitest";
import {
  normalizeObservation,
  answerRepresentation,
} from "../../packages/db/src/observation-source";
import {
  extractBrands,
  summarizeAnswers,
} from "../../packages/visibility/src/measurement";
const panel = {
  id: "panel",
  version: 1,
  prompts: [{ id: "p", text: "Tools?", label: "neutral" as const }],
  brands: [
    { id: "a", name: "Alpha", aliases: ["Alpha"], domains: ["alpha.com"] },
  ],
};
const source = {
  sourceNamespace: "CONTROLLED_FIXTURE_V1" as const,
  recordingKey: "fixture-1",
};
const evidence = {
  profile: "consumer-chatgpt" as const,
  provider: "dataforseo",
  model: "fixture",
  modelVersion: "v1",
  retrievalMode: "standard",
  requestedLocale: { language: "en" as const, market: "IN" as const },
  confirmedLocale: { language: "en", market: "IN" },
  synthetic: true,
  rawAnswerRights: true,
  observedAt: new Date(Date.now() - 86400000).toISOString(),
  slots: [
    {
      promptId: "p",
      state: "successful" as const,
      body: "Alpha is listed",
      annotations: [{ url: "https://alpha.com", start: 0, end: 5 }],
      providerTaskId: "fixture-task",
      completedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    },
  ],
};
it("keeps exact extractor/cohort facts and common clock without copying annotations into compact slots", () => {
  const value = normalizeObservation(panel, evidence, source);
  const parsed = JSON.parse(
    new TextDecoder().decode(answerRepresentation(value, 0)!),
  );
  expect(parsed.representation).toBe("ANSWER_PARSED_JSON_V1");
  expect(parsed.completedAt).toBe(evidence.slots[0]!.completedAt);
  expect(value.manifest.createdAt).toBe(evidence.observedAt);
  expect(value.manifest.slots[0]!.extraction).toEqual({
    a: {
      ...extractBrands(
        evidence.slots[0]!.body,
        evidence.slots[0]!.annotations,
        panel.brands,
      ).a,
      reason: "RECOMMENDATION_UNADJUDICATED",
    },
  });
  expect(
    summarizeAnswers(value.manifest.slots, ["a"]).brands.a!.mention.rate,
  ).toBe(1);
  expect(JSON.stringify(value.manifest)).not.toContain("https://alpha.com");
  expect(JSON.stringify(value.manifest)).not.toContain("Alpha is listed");
});
it("maps untrusted failure text to fixed codes and seals a detached immutable snapshot", () => {
  const input = structuredClone(evidence);
  const value = normalizeObservation(
    panel,
    {
      ...input,
      slots: [
        {
          ...input.slots[0]!,
          state: "failed",
          failureReason: "RAW_SECRET_SENTINEL",
          body: undefined,
          annotations: [],
        },
      ],
    },
    source,
  );
  expect(JSON.stringify(value.manifest)).not.toContain("RAW_SECRET_SENTINEL");
  expect(value.manifest.slots[0]!.failureReason).toBe("PROVIDER_FAILED");
  input.slots[0]!.body = "Changed";
  expect(new TextDecoder().decode(answerRepresentation(value, 0)!)).toBe("");
});
it.each([
  { synthetic: false },
  { rawAnswerRights: false },
  { rawRightsUntil: "2026-01-01T00:00:00Z" },
  { model: "bad\u0000model" },
  { slots: [{ ...evidence.slots[0]!, body: "x".repeat(100001) }] },
  {
    slots: [
      {
        ...evidence.slots[0]!,
        annotations: Array.from(
          { length: 257 },
          () => evidence.slots[0]!.annotations[0]!,
        ),
      },
    ],
  },
  {
    slots: [
      {
        ...evidence.slots[0]!,
        annotations: [
          { url: "https://example.com/" + "é".repeat(1024), start: 0, end: 1 },
        ],
      },
    ],
  },
  { slots: [{ ...evidence.slots[0]!, body: "\ud800" }] },
  { slots: [{ ...evidence.slots[0]!, body: "\u0001".repeat(100000) }] },
])("rejects inadmissible data before storage", (change) => {
  expect(() =>
    normalizeObservation(panel, { ...evidence, ...change }, source),
  ).toThrow();
});
it("reserves original-wire and actual producer roles instead of minting qualification", () => {
  expect(() =>
    normalizeObservation(panel, evidence, {
      ...source,
      sourceNamespace: "ACTUAL_PROVIDER",
    } as never),
  ).toThrow();
  expect(() =>
    normalizeObservation(panel, evidence, {
      ...source,
      representation: "ORIGINAL_PROVIDER_WIRE",
    } as never),
  ).toThrow();
});
it.each(["azure-sol-api", "consumer-chatgpt", "consumer-gemini"] as const)(
  "preserves %s fixture collection semantics",
  (profile) => {
    const result = normalizeObservation(
      panel,
      {
        ...evidence,
        profile,
        provider: profile === "azure-sol-api" ? "azure" : "dataforseo",
      },
      source,
    );
    expect(result.manifest.provenance.profile).toBe(profile);
  },
);
it("accepts exactly 512 KiB and rejects the next serialized UTF-8 byte without truncation", () => {
  const e = structuredClone(evidence);
  e.slots[0]!.body = "x".repeat(100000);
  e.slots[0]!.annotations = Array.from({ length: 256 }, () => ({
    url: "https://example.com/" + "x".repeat(1480),
    start: 0,
    end: 1,
  }));
  let size = answerRepresentation(
    normalizeObservation(panel, e, source),
    0,
  )!.byteLength;
  for (const annotation of e.slots[0]!.annotations) {
    const add = Math.min(
      2048 - Buffer.byteLength(annotation.url),
      512 * 1024 - size,
    );
    annotation.url += "x".repeat(add);
    size += add;
  }
  expect(size).toBe(512 * 1024);
  expect(
    answerRepresentation(normalizeObservation(panel, e, source), 0)!.byteLength,
  ).toBe(512 * 1024);
  const tail = e.slots[0]!.annotations.find(
    (x) => Buffer.byteLength(x.url) < 2048,
  )!;
  tail.url += "x";
  expect(() => normalizeObservation(panel, e, source)).toThrow(
    "ANSWER_TOO_LARGE",
  );
});
it("keeps source/IO seals private and never trusts a reconstructed normalized descriptor", async () => {
  const value = normalizeObservation(panel, evidence, source);
  const { checkedObservationSource } =
    await import("../../packages/db/src/observation-source");
  expect(() => checkedObservationSource(structuredClone(value))).toThrow(
    "UNTRUSTED_OBSERVATION_SOURCE",
  );
});
