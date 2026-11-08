import { describe, expect, it } from "vitest";
import {
  consumerStandardRequest,
  parseConsumerTaskReceipt,
} from "../../apps/lyraseo-web/src/server/providers/observations/consumer-standard";

const slot = {
  profile: "consumer-chatgpt" as const,
  prompt: "Who sells C++ & 50% off?",
  correlation: "operation:slot-1",
  language: "en" as const,
  locationCode: 2356,
};
function receipt() {
  return {
    status_code: 20000,
    tasks_count: 1,
    tasks_error: 0,
    tasks: [
      {
        id: "06231817-1535-0066-0000-9b3f8fd46bd0",
        status_code: 20100,
        cost: 0.0012,
        result_count: 0,
        result: null,
        path: ["v3", "ai_optimization", "chat_gpt", "llm_scraper", "task_post"],
        data: {
          se: "chat_gpt",
          keyword: slot.prompt,
          language_code: "en",
          location_code: 2356,
          tag: slot.correlation,
        },
      },
    ],
  };
}

describe("consumer Standard observation protocol", () => {
  it("builds one normal-priority, locale-bound task without callbacks or network access", () => {
    expect(consumerStandardRequest(slot)).toEqual({
      path: "/v3/ai_optimization/chat_gpt/llm_scraper/task_post",
      body: [
        {
          keyword: "Who%20sells%20C%2B%2B%20%26%2050%25%20off%3F",
          language_code: "en",
          location_code: 2356,
          priority: 1,
          tag: "operation:slot-1",
          force_web_search: true,
        },
      ],
    });
    expect(
      consumerStandardRequest({ ...slot, profile: "consumer-gemini" }).path,
    ).toBe("/v3/ai_optimization/gemini/llm_scraper/task_post");
  });

  it("binds a single accepted task to the frozen slot and exact provider charge", () => {
    expect(
      parseConsumerTaskReceipt(JSON.stringify(receipt()), slot),
    ).toMatchObject({
      state: "accepted",
      taskId: receipt().tasks[0]!.id,
      cost: "0.0012",
    });
  });
  it("keeps the Gemini consumer surface distinct from ChatGPT", () => {
    const data = receipt();
    data.tasks[0]!.path[2] = "gemini";
    data.tasks[0]!.data.se = "gemini";
    expect(
      parseConsumerTaskReceipt(JSON.stringify(data), {
        ...slot,
        profile: "consumer-gemini",
      }).state,
    ).toBe("accepted");
    expect(parseConsumerTaskReceipt(JSON.stringify(data), slot).state).toBe(
      "reconciliation-required",
    );
  });

  it("keeps a known accepted task when its exact cost is unavailable", () => {
    const data = receipt();
    delete (data.tasks[0] as { cost?: number }).cost;
    expect(parseConsumerTaskReceipt(JSON.stringify(data), slot)).toMatchObject({
      state: "accepted",
      taskId: data.tasks[0]!.id,
      cost: null,
    });
    for (const invalid of ["1e-7", "0.1234567891", '"0.0012"']) {
      const wire = JSON.stringify(receipt()).replace("0.0012", invalid);
      expect(parseConsumerTaskReceipt(wire, slot)).toMatchObject({
        state: "accepted",
        cost: null,
      });
    }
  });
  it.each([
    '{"exactDecimal":"0.0012"}',
    '[{"exactDecimal":"0.0012"}]',
    '{"decimal":"0.0012"}',
  ])("does not treat provider-supplied %s as a numeric cost token", (value) => {
    const wire = JSON.stringify(receipt()).replace("0.0012", value);
    expect(parseConsumerTaskReceipt(wire, slot)).toMatchObject({
      state: "accepted",
      taskId: receipt().tasks[0]!.id,
      cost: null,
    });
  });

  it("treats duplicate JSON members as uncertain, including escaped equivalent names", () => {
    const wire = JSON.stringify(receipt());
    for (const changed of [
      wire.replace(
        '"status_code":20000',
        '"status_code":40000,"status_code":20000',
      ),
      wire.replace('"id":"0623', '"id":"bad","\\u0069d":"0623'),
      wire.replace('"cost":0.0012', '"cost":999,"cost":0.0012'),
    ])
      expect(parseConsumerTaskReceipt(changed, slot).state).toBe(
        "reconciliation-required",
      );
  });
  it("treats an oversized response as uncertain rather than retryable or uncharged", () => {
    expect(parseConsumerTaskReceipt("x".repeat(65537), slot)).toEqual({
      state: "reconciliation-required",
      taskId: null,
      cost: null,
      textDigest: null,
    });
  });

  it.each([
    "bad-json",
    "duplicate",
    "wrong-tag",
    "wrong-task",
    "wrong-locale",
    "wrong-engine",
    "failed",
    "empty-id",
  ])(
    "requires reconciliation for %s, never a presumed no-charge retry",
    (scenario) => {
      const data = receipt();
      const task = data.tasks[0]!;
      if (scenario === "duplicate") {
        data.tasks.push({ ...task });
        data.tasks_count = 2;
      }
      if (scenario === "wrong-tag") task.data.tag = "another";
      if (scenario === "wrong-task") task.data.keyword = "different";
      if (scenario === "wrong-locale") task.data.location_code = 2840;
      if (scenario === "wrong-engine") task.data.se = "gemini";
      if (scenario === "failed") task.status_code = 40000;
      if (scenario === "empty-id") task.id = "";
      const result = parseConsumerTaskReceipt(
        scenario === "bad-json" ? "{" : JSON.stringify(data),
        slot,
      );
      expect(result).toMatchObject({
        state: "reconciliation-required",
        taskId: null,
        cost: null,
      });
    },
  );

  it("rejects malformed or excessive request scope before producing a request", () => {
    for (const change of [
      { prompt: "" },
      { prompt: "x".repeat(2001) },
      { correlation: "bad\nkey" },
      { locationCode: 0 },
      { language: "fr" },
    ])
      expect(() =>
        consumerStandardRequest({ ...slot, ...change } as typeof slot),
      ).toThrow("INVALID_CONSUMER_TASK");
  });
});
