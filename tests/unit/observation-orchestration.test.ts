import { expect, it, vi } from "vitest";
import { createObservationFixture } from "../../apps/lyraseo-web/src/server/providers/observations/fixture";
import {
  submitObservationFixture,
  pollObservationFixture,
  type ObservationLedger,
} from "../../apps/lyraseo-web/src/server/providers/observations/orchestrator";
const panel = {
  id: "reviewed-panel",
  version: 3,
  prompts: [{ id: "p1", text: "Which tools?", label: "neutral" as const }],
  brands: [
    {
      id: "alpha",
      name: "Alpha",
      aliases: ["Alpha"],
      domains: ["alpha.example"],
    },
  ],
};
const input = {
  operationId: "fixture-operation",
  fence: 1,
  step: "observation",
  expectedRevision: 0,
  panel,
  promptId: "p1",
  promptVersion: "panel-3:p1",
};
function ledger(granted = true) {
  const events: unknown[] = [];
  const port: ObservationLedger = {
    async prepare(i) {
      events.push({ prepare: i });
      return { id: "attempt-1", submissionGranted: granted, revision: 1 };
    },
    async record(id, key, evidence) {
      events.push({ id, key, evidence });
      return { revision: events.length };
    },
  };
  return { port, events };
}
it("prepares a durable identity before one submission and does not substitute a POST for poll", async () => {
  const { port, events } = ledger();
  const fixture = createObservationFixture("consumer-chatgpt", "complete");
  const submitted = await submitObservationFixture(port, fixture, input);
  expect(events[0]).toMatchObject({
    prepare: {
      operationId: "fixture-operation",
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  });
  expect(submitted.state).toBe("pending");
  expect(submitted.attemptId).toBe("attempt-1");
  expect(events[1]).toMatchObject({
    id: "attempt-1",
    evidence: {
      kind: "ACCEPTED",
      cost: "0.0012",
      costVersion: 1,
    },
  });
  const done = await pollObservationFixture(port, fixture, submitted);
  expect(done.result?.body).toBe("Alpha and Beta are options.");
  expect(done.state).toBe("complete");
  expect(events[2]).toMatchObject({
    evidence: {
      kind: "RESOLVED",
      cost: "0.0012",
      costVersion: 2,
      outputValid: true,
    },
  });
  expect(events.filter((e: any) => e.prepare)).toHaveLength(1);
});
it("never submits a replayed intent or retries an ambiguous submission", async () => {
  const replay = await submitObservationFixture(
    ledger(false).port,
    createObservationFixture("consumer-chatgpt", "complete"),
    input,
  );
  expect(replay.state).toBe("reconciliation-required");
  expect(replay.taskId).toBeNull();
  const { port, events } = ledger();
  const fixture = createObservationFixture(
    "consumer-chatgpt",
    "ambiguous-post",
  );
  const ambiguous = await submitObservationFixture(port, fixture, input);
  expect(ambiguous.state).toBe("reconciliation-required");
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({ evidence: { kind: "UNCERTAIN" } });
  await expect(
    pollObservationFixture(port, fixture, ambiguous),
  ).rejects.toThrow("KNOWN_TASK_REQUIRED");
});
it("retains charged invalid output, unknown costs and pending tasks independently", async () => {
  for (const scenario of [
    "refusal",
    "wrong-locale",
    "missing-cost",
    "pending",
  ] as const) {
    const { port, events } = ledger();
    const fixture = createObservationFixture("consumer-gemini", scenario);
    const submitted = await submitObservationFixture(port, fixture, input);
    const result = await pollObservationFixture(port, fixture, submitted);
    if (scenario === "pending" || scenario === "missing-cost") {
      expect(result.state).toBe(
        scenario === "pending" ? "pending" : "complete",
      );
      expect(events).toHaveLength(2);
    } else {
      expect(events[2]).toMatchObject({
        evidence: {
          kind: "RESOLVED",
          outputValid: scenario === "missing-cost",
        },
      });
    }
    if (scenario === "missing-cost")
      expect(events[1]).toMatchObject({
        evidence: { kind: "ACCEPTED" },
      });
  }
});
it("rejects forged fixtures/handles and changed frozen panel input before recording", async () => {
  const { port, events } = ledger();
  const fixture = createObservationFixture("consumer-chatgpt", "complete");
  await expect(
    submitObservationFixture(port, { ...fixture }, input),
  ).rejects.toThrow("UNTRUSTED_OBSERVATION_FIXTURE");
  await expect(
    submitObservationFixture(port, fixture, {
      ...input,
      promptId: "not-in-panel",
    }),
  ).rejects.toThrow("FROZEN_PANEL_SLOT_REQUIRED");
  expect(events).toHaveLength(0);
  const submitted = await submitObservationFixture(port, fixture, input);
  await expect(
    pollObservationFixture(port, fixture, { ...submitted, taskId: "other" }),
  ).rejects.toThrow("UNTRUSTED_OBSERVATION_HANDLE");
});
it("rejects a consumer prompt beyond the provider limit before preparing or charging an attempt", async () => {
  const { port, events } = ledger();
  const oversized = {
    ...panel,
    prompts: [{ ...panel.prompts[0]!, text: "x".repeat(2001) }],
  };
  await expect(
    submitObservationFixture(
      port,
      createObservationFixture("consumer-chatgpt", "complete"),
      { ...input, panel: oversized },
    ),
  ).rejects.toThrow("INVALID_CONSUMER_TASK");
  expect(events).toEqual([]);
});
it("has no ambient network path and separates Azure from consumer fixture calls", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw Error("NETWORK_FORBIDDEN");
  });
  try {
    const { port, events } = ledger();
    const result = await submitObservationFixture(
      port,
      createObservationFixture("azure-sol-api", "complete"),
      input,
    );
    expect(result.state).toBe("complete");
    expect(result.result?.model).toBe("synthetic-sol-v1");
    expect(events[1]).toMatchObject({
      evidence: { kind: "RESOLVED", cost: "0.0001", outputValid: true },
    });
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});
it("does not complete a truncated consumer acquisition or erase a known pending Azure acceptance", async () => {
  const consumerLedger = ledger();
  const consumer = createObservationFixture("consumer-chatgpt", "truncated");
  const submitted = await submitObservationFixture(
    consumerLedger.port,
    consumer,
    input,
  );
  const result = await pollObservationFixture(
    consumerLedger.port,
    consumer,
    submitted,
  );
  expect(result.state).not.toBe("complete");
  expect(consumerLedger.events[2]).toMatchObject({
    evidence: { cost: "0.0012", outputValid: false },
  });
  const azureLedger = ledger();
  const azure = createObservationFixture("azure-sol-api", "pending");
  await submitObservationFixture(azureLedger.port, azure, input);
  expect(azureLedger.events[1]).toMatchObject({
    evidence: {
      kind: "ACCEPTED",
      taskId: expect.stringContaining("synthetic-"),
    },
  });
});
